// YouTube 再生位置自動保存 - Popup
(function () {
  'use strict';

  const STORAGE_KEY_PREFIX = 'yt_position_';
  const SETTINGS_KEY = 'yt_position_settings';

  // i18n テキスト適用
  function applyI18n() {
    document.querySelectorAll('[data-i18n]').forEach((el) => {
      const key = el.getAttribute('data-i18n');
      const msg = chrome.i18n.getMessage(key);
      if (msg) el.textContent = msg;
    });
    // タイトル属性
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
    return result[SETTINGS_KEY] || { enabled: true };
  }

  // 設定を保存
  async function saveSettings(settings) {
    await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
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
      deleteAllBtn.disabled = true;
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
        chrome.tabs.create({ url: `https://www.youtube.com/watch?v=${v.videoId}` });
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
        // リスト再描画
        const updated = await getAllVideoData();
        renderVideoList(updated);
      });

      item.appendChild(info);
      item.appendChild(deleteBtn);
      listEl.appendChild(item);
    });
  }

  // 初期化
  async function initPopup() {
    applyI18n();

    // トグル
    const toggle = document.getElementById('enableToggle');
    const toggleLabel = document.getElementById('toggleLabel');
    const settings = await loadSettings();
    toggle.checked = settings.enabled;
    updateToggleLabel(toggle.checked, toggleLabel);

    toggle.addEventListener('change', async () => {
      const newSettings = { enabled: toggle.checked };
      await saveSettings(newSettings);
      updateToggleLabel(toggle.checked, toggleLabel);
    });

    // 全削除
    const deleteAllBtn = document.getElementById('deleteAllBtn');
    deleteAllBtn.addEventListener('click', async () => {
      const confirmMsg = chrome.i18n.getMessage('popupDeleteAllConfirm') || 'すべての保存データを削除しますか？';
      if (!confirm(confirmMsg)) return;

      const videos = await getAllVideoData();
      const keys = videos.map((v) => v.storageKey);
      await chrome.storage.local.remove(keys);
      renderVideoList([]);
    });

    // 動画リスト表示
    const videos = await getAllVideoData();
    renderVideoList(videos);
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
