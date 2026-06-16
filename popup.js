// YouTube 再生位置自動保存 - Popup
(function () {
  'use strict';

  const STORAGE_KEY_PREFIX = 'yt_position_';
  const SETTINGS_KEY = 'yt_position_settings';
  const DEFAULT_SETTINGS = {
    enabled: true,
    notifyOnRestore: true,
    autoPlayOnRestore: true,
    minSaveSeconds: 0,
    autoDeleteWatched: true,
    saveIntervalSeconds: 5,
    autoCleanupDays: 0,
    openVideoMode: 'existing'
  };

  let allVideos = [];

  // i18n テキスト適用
  function applyI18n() {
    document.querySelectorAll('[data-i18n]').forEach((el) => {
      const key = el.getAttribute('data-i18n');
      const msg = chrome.i18n.getMessage(key);
      if (msg) el.textContent = msg;
    });
    // placeholder 属性
    document.querySelectorAll('[data-i18n-placeholder]').forEach((el) => {
      const key = el.getAttribute('data-i18n-placeholder');
      const msg = chrome.i18n.getMessage(key);
      if (msg) el.placeholder = msg;
    });
    // タイトル属性
    document.querySelectorAll('[data-i18n-title]').forEach((el) => {
      const key = el.getAttribute('data-i18n-title');
      const msg = chrome.i18n.getMessage(key);
      if (msg) {
        el.title = msg;
        el.setAttribute('aria-label', msg);
      }
    });
    document.title = chrome.i18n.getMessage('extName') || document.title;
  }

  // 秒を MM:SS or HH:MM:SS に変換
  function formatTime(seconds) {
    const s = Math.floor(seconds);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    if (h > 0) {
      return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
    }
    return `${m}:${String(sec).padStart(2, '0')}`;
  }

  // 相対時間表示
  function relativeTime(timestamp) {
    const diff = Date.now() - timestamp;
    const minutes = Math.floor(diff / 60000);
    const hours = Math.floor(diff / 3600000);
    const days = Math.floor(diff / 86400000);

    if (minutes < 1) return chrome.i18n.getMessage('timeJustNow') || 'たった今';
    if (minutes < 60) return (chrome.i18n.getMessage('timeMinutesAgo') || '{n}分前').replace('{n}', minutes);
    if (hours < 24) return (chrome.i18n.getMessage('timeHoursAgo') || '{n}時間前').replace('{n}', hours);
    return (chrome.i18n.getMessage('timeDaysAgo') || '{n}日前').replace('{n}', days);
  }

  // バイト数を人間が読みやすい形式に
  function formatBytes(bytes) {
    if (bytes < 1024) return bytes + ' B';
    return (bytes / 1024).toFixed(1) + ' KB';
  }

  // 設定を読み込み
  async function loadSettings() {
    const result = await chrome.storage.local.get(SETTINGS_KEY);
    return { ...DEFAULT_SETTINGS, ...(result[SETTINGS_KEY] || {}) };
  }

  // 設定を保存
  async function saveSettings(settings) {
    await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
  }

  async function updateSettings(partialSettings) {
    const current = await loadSettings();
    const next = { ...current, ...partialSettings };
    await saveSettings(next);
    return next;
  }

  // 保存データをすべて取得
  async function getAllVideoData() {
    const allData = await chrome.storage.local.get(null);
    const videos = [];

    for (const [key, value] of Object.entries(allData)) {
      if (key.startsWith(STORAGE_KEY_PREFIX) && key !== SETTINGS_KEY) {
        const videoId = key.replace(STORAGE_KEY_PREFIX, '');
        videos.push({
          videoId,
          storageKey: key,
          ...value
        });
      }
    }

    // タイムスタンプ降順（新しい順）
    videos.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
    return videos;
  }

  // ストレージ使用量を計算
  function estimateSize(videos) {
    return new Blob([JSON.stringify(videos)]).size;
  }

  async function cleanupExpiredVideos(settings) {
    const days = Number(settings.autoCleanupDays) || 0;
    if (days <= 0) return;

    const videos = await getAllVideoData();
    const threshold = Date.now() - days * 86400000;
    const expiredKeys = videos
      .filter((video) => (video.timestamp || 0) < threshold)
      .map((video) => video.storageKey);

    if (expiredKeys.length > 0) {
      await chrome.storage.local.remove(expiredKeys);
    }
  }

  // 動画を開く（既存タブがあればそちらに切替、なければ新規タブ）
  async function openVideo(videoId) {
    const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
    const settings = await loadSettings();

    if (settings.openVideoMode === 'new') {
      await chrome.tabs.create({ url: videoUrl });
      return;
    }

    try {
      // 既存のYouTubeタブを検索
      const tabs = await chrome.tabs.query({ url: 'https://www.youtube.com/*' });
      const existingTab = tabs.find((tab) => {
        if (!tab.url) return false;
        try {
          const url = new URL(tab.url);
          return url.searchParams.get('v') === videoId;
        } catch {
          return false;
        }
      });

      if (existingTab) {
        // 既存タブをアクティブにし、そのウィンドウを前面に
        await chrome.tabs.update(existingTab.id, { active: true });
        await chrome.windows.update(existingTab.windowId, { focused: true });
      } else {
        // 既存タブがない場合は新規タブで開く
        await chrome.tabs.create({ url: videoUrl });
      }
    } catch (e) {
      // フォールバック：新規タブで開く
      await chrome.tabs.create({ url: videoUrl });
    }
  }

  // 動画リストを描画
  function renderVideoList(videos) {
    const listEl = document.getElementById('videoList');
    const emptyEl = document.getElementById('emptyMessage');
    const countEl = document.getElementById('storageCount');
    const sizeEl = document.getElementById('storageSize');
    const deleteAllBtn = document.getElementById('deleteAllBtn');

    listEl.innerHTML = '';

    // ストレージ情報
    const countLabel = (chrome.i18n.getMessage('popupVideoCount') || '{n}件の動画').replace('{n}', videos.length);
    countEl.textContent = countLabel;
    sizeEl.textContent = `≈ ${formatBytes(estimateSize(videos))}`;

    if (videos.length === 0) {
      emptyEl.style.display = 'block';
      listEl.style.display = 'none';
      deleteAllBtn.disabled = allVideos.length === 0;
      return;
    }

    emptyEl.style.display = 'none';
    listEl.style.display = 'flex';
    deleteAllBtn.disabled = false;

    videos.forEach((v) => {
      const item = document.createElement('div');
      item.className = 'video-item';

      const info = document.createElement('div');
      info.className = 'video-info';
      info.title = chrome.i18n.getMessage('popupOpenVideo') || 'YouTubeで開く';
      info.addEventListener('click', () => {
        openVideo(v.videoId);
      });

      const title = document.createElement('div');
      title.className = 'video-title';
      // タイトルから " - YouTube" を除去
      const displayTitle = (v.title || v.videoId).replace(/ - YouTube$/, '');
      title.textContent = displayTitle;

      const meta = document.createElement('div');
      meta.className = 'video-meta';
      meta.innerHTML = `<span class="position">${formatTime(v.position)}</span> / ${formatTime(v.duration)} ・ ${relativeTime(v.timestamp)}`;

      info.appendChild(title);
      info.appendChild(meta);

      const deleteBtn = document.createElement('button');
      deleteBtn.className = 'delete-btn';
      deleteBtn.textContent = '✕';
      deleteBtn.title = chrome.i18n.getMessage('popupDelete') || '削除';
      deleteBtn.addEventListener('click', async () => {
        await chrome.storage.local.remove(v.storageKey);
        item.remove();
        await refreshVideoList();
      });

      item.appendChild(info);
      item.appendChild(deleteBtn);
      listEl.appendChild(item);
    });
  }

  function getFilteredVideos() {
    const searchInput = document.getElementById('searchInput');
    const query = searchInput.value.trim().toLowerCase();
    if (!query) return allVideos;

    return allVideos.filter((v) => {
      const title = (v.title || '').toLowerCase();
      const id = v.videoId.toLowerCase();
      return title.includes(query) || id.includes(query);
    });
  }

  async function refreshVideoList() {
    allVideos = await getAllVideoData();
    renderVideoList(getFilteredVideos());
  }

  function showMainView() {
    document.getElementById('mainView').hidden = false;
    document.getElementById('settingsView').hidden = true;
  }

  function showSettingsView() {
    document.getElementById('mainView').hidden = true;
    document.getElementById('settingsView').hidden = false;
  }

  function applySettingsToForm(settings) {
    document.getElementById('notifyOnRestore').checked = settings.notifyOnRestore;
    document.getElementById('autoPlayOnRestore').checked = settings.autoPlayOnRestore;
    document.getElementById('minSaveSeconds').value = String(settings.minSaveSeconds);
    document.getElementById('autoDeleteWatched').checked = settings.autoDeleteWatched;
    document.getElementById('saveIntervalSeconds').value = String(settings.saveIntervalSeconds);
    document.getElementById('autoCleanupDays').value = String(settings.autoCleanupDays);
    document.getElementById('openVideoMode').value = settings.openVideoMode;
  }

  async function exportData() {
    const settings = await loadSettings();
    const videos = await getAllVideoData();
    const payload = {
      version: 1,
      exportedAt: new Date().toISOString(),
      settings,
      videos: videos.map(({ storageKey, ...video }) => video)
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    const date = new Date().toISOString().slice(0, 10);
    link.href = url;
    link.download = `youtube-position-saver-${date}.json`;
    link.click();
    URL.revokeObjectURL(url);
  }

  async function importData(file) {
    const text = await file.text();
    const payload = JSON.parse(text);
    const videos = Array.isArray(payload.videos) ? payload.videos : [];

    if (videos.length === 0 && !payload.settings) {
      throw new Error('Invalid import file');
    }

    const confirmMsg = chrome.i18n.getMessage('settingsImportConfirm') || '保存データをインポートしますか？';
    if (!confirm(confirmMsg)) return;

    const updates = {};

    videos.forEach((video) => {
      if (!video || !video.videoId) return;
      updates[STORAGE_KEY_PREFIX + video.videoId] = {
        position: Number(video.position) || 0,
        duration: Number(video.duration) || 0,
        timestamp: Number(video.timestamp) || Date.now(),
        title: video.title || video.videoId
      };
    });

    if (payload.settings && typeof payload.settings === 'object') {
      updates[SETTINGS_KEY] = { ...DEFAULT_SETTINGS, ...payload.settings };
    }

    if (Object.keys(updates).length > 0) {
      await chrome.storage.local.set(updates);
      const importedSettings = await loadSettings();
      applySettingsToForm(importedSettings);
      const toggle = document.getElementById('enableToggle');
      const toggleLabel = document.getElementById('toggleLabel');
      toggle.checked = importedSettings.enabled;
      updateToggleLabel(toggle.checked, toggleLabel);
      await refreshVideoList();
    }
  }

  // 初期化
  async function initPopup() {
    applyI18n();

    // トグル
    const toggle = document.getElementById('enableToggle');
    const toggleLabel = document.getElementById('toggleLabel');
    let settings = await loadSettings();
    toggle.checked = settings.enabled;
    updateToggleLabel(toggle.checked, toggleLabel);
    applySettingsToForm(settings);

    toggle.addEventListener('change', async () => {
      settings = await updateSettings({ enabled: toggle.checked });
      updateToggleLabel(toggle.checked, toggleLabel);
    });

    document.getElementById('settingsBtn').addEventListener('click', showSettingsView);
    document.getElementById('backBtn').addEventListener('click', showMainView);

    document.getElementById('notifyOnRestore').addEventListener('change', async (event) => {
      settings = await updateSettings({ notifyOnRestore: event.target.checked });
    });
    document.getElementById('autoPlayOnRestore').addEventListener('change', async (event) => {
      settings = await updateSettings({ autoPlayOnRestore: event.target.checked });
    });
    document.getElementById('minSaveSeconds').addEventListener('change', async (event) => {
      settings = await updateSettings({ minSaveSeconds: Number(event.target.value) });
    });
    document.getElementById('autoDeleteWatched').addEventListener('change', async (event) => {
      settings = await updateSettings({ autoDeleteWatched: event.target.checked });
    });
    document.getElementById('saveIntervalSeconds').addEventListener('change', async (event) => {
      settings = await updateSettings({ saveIntervalSeconds: Number(event.target.value) });
    });
    document.getElementById('autoCleanupDays').addEventListener('change', async (event) => {
      settings = await updateSettings({ autoCleanupDays: Number(event.target.value) });
      await cleanupExpiredVideos(settings);
      await refreshVideoList();
    });
    document.getElementById('openVideoMode').addEventListener('change', async (event) => {
      settings = await updateSettings({ openVideoMode: event.target.value });
    });

    // 全削除
    const deleteAllBtn = document.getElementById('deleteAllBtn');
    deleteAllBtn.addEventListener('click', async () => {
      const confirmMsg = chrome.i18n.getMessage('popupDeleteAllConfirm') || 'すべての保存データを削除しますか？';
      if (!confirm(confirmMsg)) return;

      const videos = await getAllVideoData();
      const keys = videos.map((v) => v.storageKey);
      await chrome.storage.local.remove(keys);
      allVideos = [];
      renderVideoList([]);
    });

    document.getElementById('exportBtn').addEventListener('click', exportData);
    document.getElementById('importBtn').addEventListener('click', () => {
      document.getElementById('importFile').click();
    });
    document.getElementById('importFile').addEventListener('change', async (event) => {
      const file = event.target.files[0];
      event.target.value = '';
      if (!file) return;

      try {
        await importData(file);
      } catch (e) {
        const msg = chrome.i18n.getMessage('settingsImportError') || 'インポートできませんでした';
        alert(msg);
      }
    });

    // 動画リスト表示
    await cleanupExpiredVideos(settings);
    await refreshVideoList();

    // 検索フィルター
    const searchInput = document.getElementById('searchInput');
    searchInput.addEventListener('input', () => {
      renderVideoList(getFilteredVideos());
    });
  }

  function updateToggleLabel(enabled, labelEl) {
    if (enabled) {
      labelEl.textContent = chrome.i18n.getMessage('popupEnabled') || '有効';
    } else {
      labelEl.textContent = chrome.i18n.getMessage('popupDisabled') || '無効';
    }
  }

  document.addEventListener('DOMContentLoaded', initPopup);
})();
