// YouTube 再生位置自動保存 拡張機能
(function () {
  'use strict';

  const CONTENT_SCRIPT_VERSION = '1.8.2-orphan-cleanup-20260617';
  const existingController = window.__ytPositionSaverController;

  if (existingController?.version === CONTENT_SCRIPT_VERSION) {
    existingController.scheduleInit?.();
    return;
  }

  existingController?.cleanup?.();

  const controller = {
    version: CONTENT_SCRIPT_VERSION,
    cleanup: null,
    scheduleInit: null
  };
  window.__ytPositionSaverController = controller;
  window.__ytPositionSaverLoaded = CONTENT_SCRIPT_VERSION;

  // 定数
  const STORAGE_KEY_PREFIX = 'yt_position_';
  const SAVE_INTERVAL_MS = 5000; // 保存間隔の既定値（設定未指定時のフォールバック）
  const VIDEO_CHECK_INTERVAL_MS = 100; // 動画要素チェック間隔
  const VIDEO_CHECK_TIMEOUT_MS = 5000; // 動画要素チェックタイムアウト
  const NOTIFICATION_DURATION_MS = 3000; // 通知表示時間
  const NOTIFICATION_FADE_MS = 500; // 通知フェードアウト時間
  const MIN_VALID_DURATION = 1; // 最小有効動画長（秒）
  const MIN_SAVE_TIME = 0; // 最小保存時間（秒）
  const DURATION_DIFF_THRESHOLD = 5; // 動画長さの差異許容値（秒）
  const POPSTATE_INIT_DELAY_MS = 300; // popstate後の初期化遅延
  const SEEKED_TIMEOUT_MS = 3000; // seeked イベントのタイムアウト（ms）
  const SETTINGS_KEY = 'yt_position_settings'; // 設定用ストレージキー
  const END_THRESHOLD_SEC = 3; // 動画終了判定の閾値（秒）
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

  let currentVideoId = null;
  let saveIntervalId = null;
  let videoCheckIntervalId = null; // 動画チェック用インターバルID
  let video = null;
  let lastValidPosition = null; // 最後の有効な再生位置をメモリに保持
  let isRestoring = false; // 復元中フラグ（イベント競合防止）
  let hasEnded = false; // 動画終了済みフラグ（ended後の再保存防止）
  let pausedForPendingRestore = false; // 復元準備で一時停止したかどうか
  let isLiveCached = false; // 配信中ライブかのキャッシュ（timeupdate毎のDOM計測を避ける）
  let settingsCache = { ...DEFAULT_SETTINGS };

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
    // 動画終了済みの場合は位置を更新しない
    if (hasEnded) return;

    const currentTime = video.currentTime;
    const duration = video.duration;

    if (!isRestorableCurrentVideo()) return;
    if (!isValidPosition(currentTime)) return;
    if (!isPastMinimumSaveTime(currentTime)) return;

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
    hasEnded = true;
    // 「最後まで見た動画を自動削除」がオフなら保存データを残す
    if (!settingsCache.autoDeleteWatched) return;
    lastValidPosition = null;
    if (currentVideoId) {
      try {
        chrome.storage.local.remove(getStorageKey(currentVideoId));
        console.log(`[YouTube再生位置保存] 動画終了: 保存データを削除`);
      } catch (e) {
        console.warn('[YouTube再生位置保存] 動画終了時の削除失敗:', e.message || e);
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

  // 拡張コンテキストが無効化された取り残し（orphan）インスタンスを検知したら、
  // 自分のタイマー・リスナーを停止する。無効なら true を返し、呼び出し側は早期 return する。
  // 拡張のリロード/更新で新しい content script が再注入されても、別 isolated world の
  // 旧インスタンスは window 経由で cleanup されないため、各インスタンスが自力で止まる必要がある。
  function stopIfExtensionInvalid() {
    if (isExtensionValid()) return false;
    cleanupContentScript();
    return true;
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

  function isValidDuration(duration) {
    return Number.isFinite(duration) && duration >= MIN_VALID_DURATION;
  }

  function isValidPosition(position) {
    return Number.isFinite(position) && position >= MIN_SAVE_TIME;
  }

  function isPastMinimumSaveTime(position) {
    const minSaveSeconds = Number(settingsCache.minSaveSeconds) || 0;
    return position >= minSaveSeconds;
  }

  function isValidStoredPosition(data) {
    return !!data && isValidPosition(data.position) && isValidDuration(data.duration);
  }

  // 要素が実際に表示されているか（display:none / 非表示 / サイズ0 を除外）
  function isVisibleElement(element) {
    if (!element) return false;

    const style = window.getComputedStyle?.(element);
    if (style && (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0')) {
      return false;
    }

    const rect = element.getBoundingClientRect?.();
    return !rect || rect.width > 0 || rect.height > 0;
  }

  // 配信中ライブかどうかを DOM から判定する。
  // content script は isolated world で動くため window.ytInitialPlayerResponse は読めない。
  // 配信中ライブのときだけプレイヤーの「ライブ」バッジ（.ytp-live-badge）が可視になり、
  // 通常VOD・アーカイブ（配信終了後）では display:none になることを利用する。
  // ※DVR有効ライブは video.duration が有限値になるため duration だけでは判別できず、この判定が必須。
  function detectActiveLiveFromDom() {
    return isVisibleElement(document.querySelector('.ytp-live-badge'));
  }

  // ライブ判定を再評価してキャッシュを更新する（DOM 計測はここでのみ行う）
  function updateLiveStatus() {
    isLiveCached = detectActiveLiveFromDom();
    return isLiveCached;
  }

  // 配信中ライブか（キャッシュ参照。timeupdate などのホットパスから安全に呼べる）
  function isActiveLiveVideo() {
    return isLiveCached;
  }

  function isRestorableCurrentVideo() {
    return video && !isActiveLiveVideo() && isValidDuration(video.duration);
  }

  async function removeStoredPosition(videoId, reason) {
    if (!videoId) return;

    try {
      await chrome.storage.local.remove(getStorageKey(videoId));
      console.log(`[YouTube再生位置保存] ${reason}: 保存データを削除`);
    } catch (e) {
      console.warn(`[YouTube再生位置保存] ${reason}の削除失敗:`, e.message || e);
    }
  }

  function pauseForRestore() {
    if (!video) return;
    if (!video.paused) {
      pausedForPendingRestore = true;
    }
    video.pause();
  }

  function resumeIfPausedForRestore() {
    const shouldResume = pausedForPendingRestore;
    pausedForPendingRestore = false;

    if (!shouldResume || !video || !video.paused) return;

    video.play().catch((e) => {
      console.warn('[YouTube再生位置保存] 復元スキップ後の再生再開がブロックされました:', e.message || e);
    });
  }

  function finishRestore(options = {}) {
    const { resumeIfPaused = false } = options;
    isRestoring = false;

    if (resumeIfPaused) {
      resumeIfPausedForRestore();
    } else {
      pausedForPendingRestore = false;
    }
  }

  // 再生位置を保存（共通ロジック）
  async function savePositionCore(targetVideoId, options = {}) {
    const { skipPauseCheck = false } = options;

    // 定期保存（saveIntervalId）が orphan の主な心拍。無効を検知したら自己停止する。
    if (stopIfExtensionInvalid()) return;
    if (!video || !targetVideoId) return;

    // 復元中は保存しない
    if (isRestoring) return;

    // 動画終了済みの場合は保存しない（ended後のSPA遷移で再保存されるのを防止）
    if (hasEnded) return;

    // 一時停止中は保存しない（定期保存の重複防止、オプションでスキップ可能）
    if (!skipPauseCheck && video.paused) return;

    const currentTime = video.currentTime;
    const duration = video.duration;

    // 無効な値の場合は保存しない
    if (!isRestorableCurrentVideo()) return;
    if (!isValidPosition(currentTime)) return;
    if (!isPastMinimumSaveTime(currentTime)) return;

    // 動画の終わり付近（残り END_THRESHOLD_SEC 秒以内）の場合
    // （endedイベントが発火しないケースへの対策）
    if (currentTime >= duration - END_THRESHOLD_SEC) {
      // 終了扱いにして以後の再保存を止める（自動削除オフでも末尾位置は保存しない）
      hasEnded = true;
      // 「最後まで見た動画を自動削除」がオフなら保存データを残す
      if (!settingsCache.autoDeleteWatched) return;
      lastValidPosition = null;
      try {
        await chrome.storage.local.remove(getStorageKey(targetVideoId));
        console.log(`[YouTube再生位置保存] 動画終了付近: 保存データを削除`);
      } catch (e) {
        console.warn('[YouTube再生位置保存] 動画終了付近の削除失敗:', e.message || e);
      }
      return;
    }

    const data = {
      position: currentTime,
      duration: duration,
      timestamp: Date.now(),
      title: document.title
    };

    // メモリにも保持（ページ遷移時用）
    lastValidPosition = { videoId: targetVideoId, data: data };

    try {
      await chrome.storage.local.set({ [getStorageKey(targetVideoId)]: data });
      console.log(`[YouTube再生位置保存] 保存: ${Math.floor(currentTime)}秒 / ${Math.floor(duration)}秒`);
    } catch (e) {
      console.warn('[YouTube再生位置保存] 保存失敗:', e.message || e);
    }
  }

  // 再生位置を保存（定期保存用）
  function savePosition() {
    // 定期的にライブ判定を最新化（timeupdate / 各保存はこのキャッシュを参照する）
    updateLiveStatus();
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
      console.warn('[YouTube再生位置保存] 遷移時保存失敗:', e.message || e);
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
    if (!video || !currentVideoId) {
      finishRestore({ resumeIfPaused: true });
      return;
    }

    // ストレージからデータを取得（async/awaitで順序保証）
    if (!isExtensionValid()) {
      finishRestore({ resumeIfPaused: true });
      return;
    }

    try {
      const result = await chrome.storage.local.get(getStorageKey(currentVideoId));
      const data = result[getStorageKey(currentVideoId)];

      if (data && data.position) {
        if (!isValidStoredPosition(data)) {
          await removeStoredPosition(currentVideoId, '無効な保存データ');
          finishRestore({ resumeIfPaused: true });
          return;
        }

        // ライブ判定を最新化してから復元可否を判定
        updateLiveStatus();
        if (!isRestorableCurrentVideo()) {
          await removeStoredPosition(currentVideoId, 'ライブ配信または無効な動画長');
          finishRestore({ resumeIfPaused: true });
          return;
        }

        // 動画の長さが変わっていないか確認
        if (Math.abs(video.duration - data.duration) > DURATION_DIFF_THRESHOLD) {
          console.log(`[YouTube再生位置保存] 動画の長さが異なるため復元をスキップ`);
          finishRestore({ resumeIfPaused: true });
          return;
        }

        // 復元中フラグをセット（事前セット済みでも冪等）
        isRestoring = true;

        // 一時停止してから再生位置を復元（最初の数秒が再生されるのを防ぐ）
        pauseForRestore();
        video.currentTime = data.position;

        // シークが完了したら再生を再開（タイムアウト付き）
        await new Promise((resolve) => {
          let settled = false;
          const handleSeeked = () => {
            if (settled) return;
            settled = true;
            video.removeEventListener('seeked', handleSeeked);
            resolve();
          };
          video.addEventListener('seeked', handleSeeked);
          // seeked が発火しない場合のフォールバック
          setTimeout(() => {
            if (!settled) {
              settled = true;
              video.removeEventListener('seeked', handleSeeked);
              console.log('[YouTube再生位置保存] seeked タイムアウト: フォールバックで続行');
              resolve();
            }
          }, SEEKED_TIMEOUT_MS);
        });

        // 復元完了、設定に応じて再生開始
        if (settingsCache.autoPlayOnRestore) {
          video.play().catch((e) => {
            console.warn('[YouTube再生位置保存] 自動再生がブロックされました:', e.message || e);
          });
        }

        // 復元中フラグを解除
        finishRestore();

        console.log(`[YouTube再生位置保存] 復元: ${Math.floor(data.position)}秒から再開`);

        // 復元完了を通知（トースト表示）
        if (settingsCache.notifyOnRestore) {
          const messageTemplate = chrome.i18n.getMessage('notificationResumeAt') || '{position}秒から再開します';
          showNotification(messageTemplate.replace('{position}', Math.floor(data.position)));
        }
      } else {
        // 保存データがない場合はフラグを解除
        finishRestore({ resumeIfPaused: true });
      }
    } catch (e) {
      finishRestore({ resumeIfPaused: true });
      console.warn('[YouTube再生位置保存] 復元処理でエラー:', e.message || e);
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
    const intervalMs = (Number(settingsCache.saveIntervalSeconds) || 0) * 1000 || SAVE_INTERVAL_MS;
    saveIntervalId = setInterval(savePosition, intervalMs);
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

  // 設定を読み込み
  async function loadSettings() {
    try {
      const result = await chrome.storage.local.get(SETTINGS_KEY);
      settingsCache = { ...DEFAULT_SETTINGS, ...(result[SETTINGS_KEY] || {}) };
    } catch (e) {
      settingsCache = { ...DEFAULT_SETTINGS };
    }
    return settingsCache;
  }

  // 設定の有効/無効をチェック
  async function isEnabled() {
    const settings = await loadSettings();
    return settings.enabled !== false;
  }

  // メイン処理
  async function init() {
    // orphan（拡張コンテキストが無効化された旧インスタンス）はここで自己停止する
    // （「動画検出」ログや動画チェック用 setInterval を無駄に起動しないため）
    if (stopIfExtensionInvalid()) return;

    // 設定で無効化されている場合は停止
    if (!(await isEnabled())) {
      stopSaving();
      currentVideoId = null;
      return;
    }

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
    hasEnded = false; // 新しい動画への遷移時にリセット
    isLiveCached = false; // 前の動画のライブ判定を引き継がない（既定は復元対象＝非ライブ）
    console.log(`[YouTube再生位置保存] 動画検出: ${videoId}`);

    // 前のインターバルをクリーンアップ
    cleanupVideoCheckInterval();

    // 動画要素を待機してセットアップ
    // クロージャでキャプチャし、コールバック実行時のコンテキスト混線を防止
    const capturedVideoId = videoId;
    videoCheckIntervalId = setInterval(async () => {
      if (setupVideo()) {
        cleanupVideoCheckInterval();

        // 遷移済みなら中断（急速連続遷移対策）
        if (currentVideoId !== capturedVideoId) return;

        // ライブ判定を最新化（プレイヤーの「ライブ」バッジの可視状態で判定）
        updateLiveStatus();

        // orphan はここの storage 読み取りで例外＝「保存データ確認失敗」を出すため、手前で停止する
        if (stopIfExtensionInvalid()) return;

        // 復元可能な保存データがあるか事前にチェック
        let hasRestorableStoredPosition = false;
        try {
          const result = await chrome.storage.local.get(getStorageKey(capturedVideoId));
          hasRestorableStoredPosition = isValidStoredPosition(result[getStorageKey(capturedVideoId)]) && !isActiveLiveVideo();
        } catch (e) {
          console.warn('[YouTube再生位置保存] 保存データ確認失敗:', e.message || e);
        }

        // 遷移済みなら中断（async後の再チェック）
        if (currentVideoId !== capturedVideoId) return;

        // 復元可能な保存データがある場合は復元前の保存を抑止してから一時停止
        // （pause イベントで現在位置=0付近が保存され、復元データを上書きするのを防ぐ）
        if (hasRestorableStoredPosition) {
          isRestoring = true;
          pauseForRestore();
        }

        // 動画のメタデータが読み込まれたら復元
        if (video.readyState >= 1) {
          await restorePosition();
          startSaving();
        } else {
          video.addEventListener('loadedmetadata', async () => {
            // loadedmetadata発火時に動画IDが変わっていたら復元しない
            if (currentVideoId !== capturedVideoId) return;
            await restorePosition();
            startSaving();
          }, { once: true });
        }
      }
    }, VIDEO_CHECK_INTERVAL_MS);

    // タイムアウト
    setTimeout(() => cleanupVideoCheckInterval(), VIDEO_CHECK_TIMEOUT_MS);
  }

  function handleBeforeUnload() {
    saveForNavigation();
  }

  function handleYtNavigateFinish() {
    lastNavigateFinishAt = Date.now();
    saveForNavigation();
    scheduleInit(0);
  }

  function handlePopState() {
    saveForNavigation();

    // yt-navigate-finish直後のpopstateは二重初期化になりやすいので抑止
    const now = Date.now();
    if (now - lastNavigateFinishAt < 250) return;

    scheduleInit(POPSTATE_INIT_DELAY_MS);
  }

  function handleVisibilityChange() {
    if (document.hidden) {
      saveForNavigation();
    }
  }

  function handleSettingsChanged(changes, areaName) {
    if (areaName !== 'local' || !changes[SETTINGS_KEY]) return;

    settingsCache = { ...DEFAULT_SETTINGS, ...(changes[SETTINGS_KEY].newValue || {}) };

    if (settingsCache.enabled === false) {
      stopSaving();
      currentVideoId = null;
      return;
    }

    // 保存中なら新しい保存間隔で張り替える
    // （init() は同じ動画だと早期 return するため、ここで明示的に再起動する）
    if (saveIntervalId) {
      startSaving();
    }

    scheduleInit(0);
  }

  function cleanupContentScript() {
    if (initTimerId) {
      clearTimeout(initTimerId);
      initTimerId = null;
    }
    stopSaving();
    cleanupVideoCheckInterval();
    cleanupVideoListeners();

    window.removeEventListener('beforeunload', handleBeforeUnload);
    window.removeEventListener('yt-navigate-finish', handleYtNavigateFinish);
    window.removeEventListener('popstate', handlePopState);
    document.removeEventListener('visibilitychange', handleVisibilityChange);

    try {
      chrome.storage.onChanged.removeListener(handleSettingsChanged);
    } catch (e) {
      // 拡張コンテキスト破棄後のクリーンアップでは失敗することがある。
    }
  }

  controller.cleanup = cleanupContentScript;
  controller.scheduleInit = () => scheduleInit(0);

  // ページ離脱時に保存
  window.addEventListener('beforeunload', handleBeforeUnload);

  // YouTubeのナビゲーションイベントを使用（MutationObserverより効率的）
  window.addEventListener('yt-navigate-finish', handleYtNavigateFinish);

  // popstate（戻る/進むボタン）でも動作
  window.addEventListener('popstate', handlePopState);

  // visibilitychange（タブ切り替え時）に保存
  document.addEventListener('visibilitychange', handleVisibilityChange);

  chrome.storage.onChanged.addListener(handleSettingsChanged);

  // 初期化
  scheduleInit(0);

})();
