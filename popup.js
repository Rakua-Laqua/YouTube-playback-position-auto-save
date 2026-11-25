// YouTube 再生位置自動保存 - Popup
(function () {
  'use strict';

  const Shared = globalThis.YtPositionSaverShared;
  if (!Shared) {
    console.error('[YouTube再生位置保存] shared.js が読み込まれていません');
    return;
  }

  const STORAGE_KEY_PREFIX = 'yt_position_';
  const SETTINGS_KEY = 'yt_position_settings';
  const DEFAULT_SETTINGS = Shared.DEFAULT_SETTINGS;
  const SEARCH_DEBOUNCE_MS = 150;

  let allVideos = [];
  let cachedStorageSize = 0;
  let searchDebounceTimerId = null;

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
    const s = Math.floor(Number(seconds) || 0);
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
    const diff = Date.now() - (Number(timestamp) || 0);
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

  function showFatalError(error) {
    const msg = chrome.i18n.getMessage('popupFatalError')
      || 'ポップアップの初期化に失敗しました。拡張機能を再読み込みしてください。';
    console.error('[YouTube再生位置保存] popup fatal:', error);
    const container = document.querySelector('.container');
    if (container) {
      container.textContent = msg;
      return;
    }
    alert(msg);
  }

  function showOperationError(error) {
    const msg = chrome.i18n.getMessage('popupOperationError')
      || '操作に失敗しました。もう一度お試しください。';
    console.warn('[YouTube再生位置保存] popup operation failed:', error?.message || error);
    alert(msg);
  }

  function withErrorBoundary(asyncFn) {
    return (...args) => {
      Promise.resolve()
        .then(() => asyncFn(...args))
        .catch(showOperationError);
    };
  }

  // 設定を読み込み
  async function loadSettings() {
    try {
      const result = await chrome.storage.local.get(SETTINGS_KEY);
      return Shared.normalizeSettings(result[SETTINGS_KEY]);
    } catch (e) {
      console.warn('[YouTube再生位置保存] 設定読込失敗:', e.message || e);
      throw e;
    }
  }

  // 設定を保存
  async function saveSettings(settings) {
    const normalized = Shared.normalizeSettings(settings);
    await chrome.storage.local.set({ [SETTINGS_KEY]: normalized });
    return normalized;
  }

  async function updateSettings(partialSettings) {
    const current = await loadSettings();
    return saveSettings({ ...current, ...partialSettings });
  }

  // 保存データをすべて取得
  async function getAllVideoData() {
    const allData = await chrome.storage.local.get(null);
    const videos = [];

    for (const [key, value] of Object.entries(allData)) {
      if (key.startsWith(STORAGE_KEY_PREFIX) && key !== SETTINGS_KEY) {
        const videoId = key.replace(STORAGE_KEY_PREFIX, '');
        const normalized = Shared.normalizeVideoRecord({
          videoId,
          ...(value && typeof value === 'object' ? value : {})
        });
        if (!normalized) continue;
        videos.push({
          ...normalized,
          storageKey: key
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

  function setAllVideos(videos) {
    allVideos = videos;
    cachedStorageSize = estimateSize(allVideos);
  }

  async function cleanupExpiredVideos(settings, videos = null) {
    const days = Number(settings.autoCleanupDays) || 0;
    if (days <= 0) return videos;

    const source = videos || await getAllVideoData();
    const threshold = Date.now() - days * 86400000;
    const expiredKeys = [];
    const remaining = [];

    for (const video of source) {
      if ((video.timestamp || 0) < threshold) {
        expiredKeys.push(video.storageKey);
      } else {
        remaining.push(video);
      }
    }

    if (expiredKeys.length > 0) {
      await chrome.storage.local.remove(expiredKeys);
    }

    return remaining;
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

    listEl.replaceChildren();

    // ストレージ情報
    const displayedCount = videos.length === allVideos.length ? String(videos.length) : `${videos.length} / ${allVideos.length}`;
    const countLabel = (chrome.i18n.getMessage('popupVideoCount') || '{n}件の動画').replace('{n}', displayedCount);
    countEl.textContent = countLabel;
    sizeEl.textContent = `≈ ${formatBytes(cachedStorageSize)}`;

    if (videos.length === 0) {
      emptyEl.style.display = 'block';
      listEl.style.display = 'none';
      deleteAllBtn.disabled = allVideos.length === 0;
      return;
    }

    emptyEl.style.display = 'none';
    listEl.style.display = 'flex';
    deleteAllBtn.disabled = false;

    const fragment = document.createDocumentFragment();

    videos.forEach((v) => {
      const item = document.createElement('div');
      item.className = 'video-item';

      const info = document.createElement('div');
      info.className = 'video-info';
      info.title = chrome.i18n.getMessage('popupOpenVideo') || 'YouTubeで開く';
      info.addEventListener('click', withErrorBoundary(() => openVideo(v.videoId)));

      const title = document.createElement('div');
      title.className = 'video-title';
      // タイトルから " - YouTube" を除去
      const rawTitle = typeof v.title === 'string' ? v.title : v.videoId;
      const displayTitle = rawTitle.replace(/ - YouTube$/, '');
      title.textContent = displayTitle;

      const meta = document.createElement('div');
      meta.className = 'video-meta';
      const position = document.createElement('span');
      position.className = 'position';
      position.textContent = formatTime(v.position);
      meta.appendChild(position);
      meta.appendChild(document.createTextNode(` / ${formatTime(v.duration)} ・ ${relativeTime(v.timestamp)}`));

      info.appendChild(title);
      info.appendChild(meta);

      const deleteBtn = document.createElement('button');
      deleteBtn.className = 'delete-btn';
      deleteBtn.textContent = '✕';
      deleteBtn.title = chrome.i18n.getMessage('popupDelete') || '削除';
      deleteBtn.addEventListener('click', withErrorBoundary(async () => {
        await chrome.storage.local.remove(v.storageKey);
        item.remove();
        await refreshVideoList();
      }));

      item.appendChild(info);
      item.appendChild(deleteBtn);
      fragment.appendChild(item);
    });

    listEl.appendChild(fragment);
  }

  function getFilteredVideos() {
    const searchInput = document.getElementById('searchInput');
    const query = searchInput.value.trim().toLowerCase();
    if (!query) return allVideos;

    return allVideos.filter((v) => {
      const title = (typeof v.title === 'string' ? v.title : '').toLowerCase();
      const id = v.videoId.toLowerCase();
      return title.includes(query) || id.includes(query);
    });
  }

  async function refreshVideoList(preloadedVideos = null) {
    setAllVideos(preloadedVideos || await getAllVideoData());
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
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function importData(file) {
    if (file.size > Shared.MAX_IMPORT_BYTES) {
      throw new Error('Import file too large');
    }

    const text = await file.text();
    const parsed = Shared.parseImportPayload(text, file.size);

    const confirmMsg = chrome.i18n.getMessage('settingsImportConfirm') || '保存データをインポートしますか？';
    if (!confirm(confirmMsg)) return;

    const updates = {};

    parsed.videos.forEach((video) => {
      updates[STORAGE_KEY_PREFIX + video.videoId] = {
        position: video.position,
        duration: video.duration,
        timestamp: video.timestamp,
        title: video.title
      };
    });

    if (parsed.settings) {
      updates[SETTINGS_KEY] = parsed.settings;
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

    toggle.addEventListener('change', withErrorBoundary(async () => {
      settings = await updateSettings({ enabled: toggle.checked });
      updateToggleLabel(toggle.checked, toggleLabel);
    }));

    document.getElementById('settingsBtn').addEventListener('click', showSettingsView);
    document.getElementById('backBtn').addEventListener('click', showMainView);

    document.getElementById('notifyOnRestore').addEventListener('change', withErrorBoundary(async (event) => {
      settings = await updateSettings({ notifyOnRestore: event.target.checked });
    }));
    document.getElementById('autoPlayOnRestore').addEventListener('change', withErrorBoundary(async (event) => {
      settings = await updateSettings({ autoPlayOnRestore: event.target.checked });
    }));
    document.getElementById('minSaveSeconds').addEventListener('change', withErrorBoundary(async (event) => {
      settings = await updateSettings({ minSaveSeconds: Number(event.target.value) });
    }));
    document.getElementById('autoDeleteWatched').addEventListener('change', withErrorBoundary(async (event) => {
      settings = await updateSettings({ autoDeleteWatched: event.target.checked });
    }));
    document.getElementById('saveIntervalSeconds').addEventListener('change', withErrorBoundary(async (event) => {
      settings = await updateSettings({ saveIntervalSeconds: Number(event.target.value) });
    }));
    document.getElementById('autoCleanupDays').addEventListener('change', withErrorBoundary(async (event) => {
      settings = await updateSettings({ autoCleanupDays: Number(event.target.value) });
      const remaining = await cleanupExpiredVideos(settings, allVideos);
      await refreshVideoList(remaining);
    }));
    document.getElementById('openVideoMode').addEventListener('change', withErrorBoundary(async (event) => {
      settings = await updateSettings({ openVideoMode: event.target.value });
    }));

    // 全削除
    const deleteAllBtn = document.getElementById('deleteAllBtn');
    deleteAllBtn.addEventListener('click', withErrorBoundary(async () => {
      const confirmMsg = chrome.i18n.getMessage('popupDeleteAllConfirm') || 'すべての保存データを削除しますか？';
      if (!confirm(confirmMsg)) return;

      const videos = await getAllVideoData();
      const keys = videos.map((v) => v.storageKey);
      await chrome.storage.local.remove(keys);
      setAllVideos([]);
      renderVideoList([]);
    }));

    document.getElementById('exportBtn').addEventListener('click', withErrorBoundary(exportData));
    document.getElementById('importBtn').addEventListener('click', () => {
      document.getElementById('importFile').click();
    });
    document.getElementById('importFile').addEventListener('change', withErrorBoundary(async (event) => {
      const file = event.target.files[0];
      event.target.value = '';
      if (!file) return;

      try {
        await importData(file);
      } catch (e) {
        const msg = chrome.i18n.getMessage('settingsImportError') || 'インポートできませんでした';
        alert(msg);
      }
    }));

    // 動画リスト表示（自動整理後の配列をそのまま使い、再取得を省く）
    const videos = await getAllVideoData();
    const remaining = await cleanupExpiredVideos(settings, videos);
    await refreshVideoList(remaining || videos);

    // 検索フィルター（debounce）
    const searchInput = document.getElementById('searchInput');
    searchInput.addEventListener('input', () => {
      if (searchDebounceTimerId) {
        clearTimeout(searchDebounceTimerId);
      }
      searchDebounceTimerId = setTimeout(() => {
        searchDebounceTimerId = null;
        renderVideoList(getFilteredVideos());
      }, SEARCH_DEBOUNCE_MS);
    });
  }

  function updateToggleLabel(enabled, labelEl) {
    if (enabled) {
      labelEl.textContent = chrome.i18n.getMessage('popupEnabled') || '有効';
    } else {
      labelEl.textContent = chrome.i18n.getMessage('popupDisabled') || '無効';
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    void initPopup().catch(showFatalError);
  });
})();
