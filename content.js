// YouTube 再生位置自動保存 拡張機能
(function() {
  'use strict';

  // 定数
  const STORAGE_KEY_PREFIX = 'yt_position_';
  const SAVE_INTERVAL_MS = 5000; // 5秒ごとに保存
  const VIDEO_CHECK_INTERVAL_MS = 100; // 動画要素チェック間隔
  const VIDEO_CHECK_TIMEOUT_MS = 5000; // 動画要素チェックタイムアウト
  const NOTIFICATION_DURATION_MS = 3000; // 通知表示時間
  const NOTIFICATION_FADE_MS = 500; // 通知フェードアウト時間
  const MIN_VALID_DURATION = 1; // 最小有効動画長（秒）
  const MIN_SAVE_TIME = 0; // 最小保存時間（秒）
  const DURATION_DIFF_THRESHOLD = 5; // 動画長さの差異許容値（秒）
  const POPSTATE_INIT_DELAY_MS = 300; // popstate後の初期化遅延

  let currentVideoId = null;
  let saveIntervalId = null;
  let videoCheckIntervalId = null; // 動画チェック用インターバルID
  let video = null;
  let lastValidPosition = null; // 最後の有効な再生位置をメモリに保持
  let isRestoring = false; // 復元中フラグ（イベント競合防止）

  // initの多重起動抑止
  let initTimerId = null;
  let lastNavigateFinishAt = 0;

  function scheduleInit(delayMs = 0) {
    if (initTimerId) {
      clearTimeout(initTimerId);
    }
    initTimerId = setTimeout(() => {
      initTimerId = null;
      init();
    }, delayMs);
  }

  // イベントハンドラー（削除用に参照を保持）
  function handlePause() {
    savePositionOnPause();
  }
  
  function handleTimeUpdate() {
    if (!currentVideoId || !video) return;
    
    const currentTime = video.currentTime;
    const duration = video.duration;
    
    if (!duration || isNaN(duration) || duration < MIN_VALID_DURATION) return;
    if (isNaN(currentTime) || currentTime < MIN_SAVE_TIME) return;
    
    // メモリに最新位置を保持
    lastValidPosition = {
      videoId: currentVideoId,
      data: {
        position: currentTime,
        duration: duration,
        timestamp: Date.now(),
        title: document.title
      }
    };
  }
  
  function handleEnded() {
    // 動画終了時は保存データを削除
    if (!isExtensionValid()) return;
    if (currentVideoId) {
      try {
        chrome.storage.local.remove(getStorageKey(currentVideoId));
        lastValidPosition = null;
        console.log(`[YouTube再生位置保存] 動画終了: 保存データを削除`);
      } catch (e) {
        // 拡張機能が無効な場合は無視
      }
    }
  }

  // 拡張機能が有効かチェック
  function isExtensionValid() {
    try {
      return chrome.runtime && chrome.runtime.id;
    } catch (e) {
      return false;
    }
  }

  // 動画IDをURLから取得
  function getVideoId() {
    const urlParams = new URLSearchParams(window.location.search);
    return urlParams.get('v');
  }

  // ストレージキーを生成
  function getStorageKey(videoId) {
    return STORAGE_KEY_PREFIX + videoId;
  }

  // 再生位置を保存（共通ロジック）
  function savePositionCore(targetVideoId, options = {}) {
    const { skipPauseCheck = false } = options;
    
    if (!isExtensionValid()) return;
    if (!video || !targetVideoId) return;
    
    // 復元中は保存しない
    if (isRestoring) return;
    
    // 一時停止中は保存しない（定期保存の重複防止、オプションでスキップ可能）
    if (!skipPauseCheck && video.paused) return;
    
    const currentTime = video.currentTime;
    const duration = video.duration;

    // 無効な値の場合は保存しない
    if (!duration || isNaN(duration) || duration < MIN_VALID_DURATION) return;
    if (isNaN(currentTime) || currentTime < MIN_SAVE_TIME) return;

    const data = {
      position: currentTime,
      duration: duration,
      timestamp: Date.now(),
      title: document.title
    };

    // メモリにも保持（ページ遷移時用）
    lastValidPosition = { videoId: targetVideoId, data: data };

    try {
      chrome.storage.local.set({ [getStorageKey(targetVideoId)]: data });
      console.log(`[YouTube再生位置保存] 保存: ${Math.floor(currentTime)}秒 / ${Math.floor(duration)}秒`);
    } catch (e) {
      console.log('[YouTube再生位置保存] 保存失敗: 拡張機能が無効です');
    }
  }

  // 再生位置を保存（定期保存用）
  function savePosition() {
    savePositionCore(currentVideoId, { skipPauseCheck: false });
  }

  // 一時停止時の保存（pauseチェックなし）
  function savePositionOnPause() {
    savePositionCore(currentVideoId, { skipPauseCheck: true });
  }

  // メモリに保持した最後の位置を保存（ページ遷移時用）
  function saveLastValidPosition() {
    if (!isExtensionValid()) return;
    if (!lastValidPosition) return;

    try {
      chrome.storage.local.set({ [getStorageKey(lastValidPosition.videoId)]: lastValidPosition.data });
      console.log(`[YouTube再生位置保存] 遷移時保存: ${Math.floor(lastValidPosition.data.position)}秒`);
    } catch (e) {
      // 拡張機能が無効な場合は無視
    }
  }

  // 遷移/非表示/離脱時の保存を統一（popstate等の相性改善）
  function saveForNavigation() {
    // 可能なら現在のvideoから直接保存（lastValidPositionに依存しない）
    if (currentVideoId && video) {
      savePositionCore(currentVideoId, { skipPauseCheck: true });
    } else {
      saveLastValidPosition();
    }
    lastValidPosition = null;
  }

  // 保存された再生位置を復元
  async function restorePosition() {
    if (!video || !currentVideoId) return;

    // ストレージからデータを取得（async/awaitで順序保証）
    if (!isExtensionValid()) return;
    
    try {
      const result = await chrome.storage.local.get(getStorageKey(currentVideoId));
      const data = result[getStorageKey(currentVideoId)];
      
      if (data && data.position) {
        // 動画の長さが変わっていないか確認
        if (video.duration && Math.abs(video.duration - data.duration) > DURATION_DIFF_THRESHOLD) {
          console.log(`[YouTube再生位置保存] 動画の長さが異なるため復元をスキップ`);
          return;
        }

        // 復元中フラグをセット
        isRestoring = true;

        // 一時停止してから再生位置を復元（最初の数秒が再生されるのを防ぐ）
        video.pause();
        video.currentTime = data.position;
        
        // シークが完了したら再生を再開
        await new Promise((resolve) => {
          const handleSeeked = () => {
            video.removeEventListener('seeked', handleSeeked);
            resolve();
          };
          video.addEventListener('seeked', handleSeeked);
        });
        
        // 復元完了、再生開始
        video.play().catch(() => {
          // 自動再生がブロックされた場合は無視
        });
        
        // 復元中フラグを解除
        isRestoring = false;
        
        console.log(`[YouTube再生位置保存] 復元: ${Math.floor(data.position)}秒から再開`);
        
        // 復元完了を通知（トースト表示）
        showNotification(`${Math.floor(data.position)}秒から再開します`);
      }
    } catch (e) {
      isRestoring = false;
      // 拡張機能が無効な場合は無視
    }
  }

  // 通知を表示
  function showNotification(message) {
    const notification = document.createElement('div');
    notification.textContent = message;
    notification.style.cssText = `
      position: fixed;
      top: 80px;
      right: 20px;
      background: rgba(0, 0, 0, 0.8);
      color: white;
      padding: 12px 20px;
      border-radius: 8px;
      font-size: 14px;
      z-index: 9999;
      transition: opacity 0.5s;
      font-family: 'Roboto', 'Noto Sans JP', sans-serif;
    `;
    document.body.appendChild(notification);

    setTimeout(() => {
      notification.style.opacity = '0';
      setTimeout(() => notification.remove(), NOTIFICATION_FADE_MS);
    }, NOTIFICATION_DURATION_MS);
  }

  // 定期保存を開始
  function startSaving() {
    if (saveIntervalId) {
      clearInterval(saveIntervalId);
    }
    saveIntervalId = setInterval(savePosition, SAVE_INTERVAL_MS);
  }

  // 定期保存を停止
  function stopSaving() {
    if (saveIntervalId) {
      clearInterval(saveIntervalId);
      saveIntervalId = null;
    }
  }

  // 動画チェックインターバルをクリーンアップ
  function cleanupVideoCheckInterval() {
    if (videoCheckIntervalId) {
      clearInterval(videoCheckIntervalId);
      videoCheckIntervalId = null;
    }
  }

  // 動画のイベントリスナーをクリーンアップ
  function cleanupVideoListeners() {
    if (video) {
      video.removeEventListener('pause', handlePause);
      video.removeEventListener('timeupdate', handleTimeUpdate);
      video.removeEventListener('ended', handleEnded);
    }
  }

  // 動画要素を取得してセットアップ
  function setupVideo() {
    const newVideo = document.querySelector('video.html5-main-video');
    if (!newVideo) return false;

    // 同じ動画要素の場合はスキップ
    if (video === newVideo) return true;

    // 前のリスナーを削除
    cleanupVideoListeners();
    
    video = newVideo;

    // イベントリスナーを設定
    video.addEventListener('pause', handlePause);
    video.addEventListener('timeupdate', handleTimeUpdate);
    video.addEventListener('ended', handleEnded);

    return true;
  }

  // メイン処理
  async function init() {
    const videoId = getVideoId();
    
    // 動画ページでない場合は何もしない
    if (!videoId) {
      stopSaving();
      currentVideoId = null;
      return;
    }

    // 同じ動画の場合は何もしない
    if (videoId === currentVideoId) return;

    // 前の動画の位置を保存（競合状態防止：先にIDを保持）
    const previousVideoId = currentVideoId;
    if (previousVideoId) {
      savePositionCore(previousVideoId, { skipPauseCheck: true });
    }

    currentVideoId = videoId;
    console.log(`[YouTube再生位置保存] 動画検出: ${videoId}`);

    // 前のインターバルをクリーンアップ
    cleanupVideoCheckInterval();

    // 動画要素を待機してセットアップ
    videoCheckIntervalId = setInterval(async () => {
      if (setupVideo()) {
        cleanupVideoCheckInterval();
        
        // 保存データがあるか事前にチェック
        let hasStoredPosition = false;
        try {
          const result = await chrome.storage.local.get(getStorageKey(currentVideoId));
          hasStoredPosition = !!(result[getStorageKey(currentVideoId)]?.position);
        } catch (e) {
          // 無視
        }
        
        // 保存データがある場合は即座に一時停止（最初の数秒再生を防ぐ）
        if (hasStoredPosition) {
          video.pause();
        }
        
        // 動画のメタデータが読み込まれたら復元
        if (video.readyState >= 1) {
          await restorePosition();
          startSaving();
        } else {
          video.addEventListener('loadedmetadata', async () => {
            await restorePosition();
            startSaving();
          }, { once: true });
        }
      }
    }, VIDEO_CHECK_INTERVAL_MS);

    // タイムアウト
    setTimeout(() => cleanupVideoCheckInterval(), VIDEO_CHECK_TIMEOUT_MS);
  }

  // ページ離脱時に保存
  window.addEventListener('beforeunload', () => {
    saveForNavigation();
  });

  // 初期化
  scheduleInit(0);

  // YouTubeのナビゲーションイベントを使用（MutationObserverより効率的）
  window.addEventListener('yt-navigate-finish', () => {
    lastNavigateFinishAt = Date.now();
    saveForNavigation();
    scheduleInit(0);
  });

  // popstate（戻る/進むボタン）でも動作
  window.addEventListener('popstate', () => {
    saveForNavigation();

    // yt-navigate-finish直後のpopstateは二重初期化になりやすいので抑止
    const now = Date.now();
    if (now - lastNavigateFinishAt < 250) return;

    scheduleInit(POPSTATE_INIT_DELAY_MS);
  });

  // visibilitychange（タブ切り替え時）に保存
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      saveForNavigation();
    }
  });

})();
