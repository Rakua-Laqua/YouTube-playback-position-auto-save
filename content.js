// YouTube 再生位置自動保存 拡張機能
(function () {
  'use strict';

  const Shared = globalThis.YtPositionSaverShared;
  if (!Shared) {
    console.error('[YouTube再生位置保存] shared.js が読み込まれていません');
    return;
  }

  const CONTENT_SCRIPT_VERSION = '1.9.1-invalidate-init-20260719';
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
  const VIDEO_CHECK_INTERVAL_MS = 100; // 動画要素チェック間隔
  const VIDEO_CHECK_TIMEOUT_MS = 5000; // 動画要素チェックタイムアウト
  const NOTIFICATION_DURATION_MS = 3000; // 通知表示時間
  const NOTIFICATION_FADE_MS = 500; // 通知フェードアウト時間
  const MIN_VALID_DURATION = 1; // 最小有効動画長（秒）
  const MIN_SAVE_TIME = 0; // 最小保存時間（秒）
  const DURATION_DIFF_THRESHOLD = 5; // 動画長さの差異許容値（秒）
  const POPSTATE_INIT_DELAY_MS = 300; // popstate後の初期化遅延
  const SEEKED_TIMEOUT_MS = 3000; // seeked イベントのタイムアウト（ms）
  const AD_RESTORE_RETRY_MS = 1000; // 広告終了待ちの復元リトライ間隔
  const AD_RESTORE_MAX_WAIT_MS = 120000; // 広告終了待ちの最大時間
  const SETTINGS_KEY = 'yt_position_settings'; // 設定用ストレージキー
  const END_THRESHOLD_SEC = 3; // 動画終了判定の閾値（秒）
  const DEFAULT_SETTINGS = Shared.DEFAULT_SETTINGS;
  const PING_MESSAGE_TYPE = 'yt-position-saver-ping';

  let currentVideoId = null;
  let saveIntervalId = null;
  let video = null;
  let lastValidPosition = null; // 最後の有効な再生位置をメモリに保持（不変スナップショット）
  let hasEnded = false; // 動画終了済みフラグ（ended後の再保存防止）
  let isLiveCached = false; // 配信中ライブかのキャッシュ（timeupdate毎のDOM計測を避ける）
  let settingsCache = Shared.normalizeSettings(DEFAULT_SETTINGS);
  let settingsLoadFailed = false;

  // 動画セッション（世代管理）
  let sessionGeneration = 0;
  let activeSession = Shared.createVideoSession(0, null);

  // initの多重起動抑止（未起動タイマーの取消 + 実行中 init の requestId 無効化）
  let initTimerId = null;
  let initRequestId = 0;
  let lastNavigateFinishAt = 0;

  // 保留中タイマーと実行中 init の両方を失効させる（cleanup / 設定無効化で共用）
  function invalidateInitRequests() {
    initRequestId += 1;
    if (initTimerId) {
      clearTimeout(initTimerId);
      initTimerId = null;
    }
  }

  function scheduleInit(delayMs = 0) {
    const requestId = ++initRequestId;
    if (initTimerId) {
      clearTimeout(initTimerId);
    }
    initTimerId = setTimeout(() => {
      initTimerId = null;
      init(requestId).catch((e) => {
        console.warn('[YouTube再生位置保存] init失敗:', e.message || e);
      });
    }, delayMs);
  }

  function isCurrentInitRequest(requestId) {
    return Shared.isLatestInitRequest(requestId, initRequestId);
  }

  function detachActiveMedia() {
    stopSaving();
    cleanupVideoListeners();
    video = null;
  }

  function beginSession(videoId) {
    // セッション内タイマーに加え、定期保存・旧videoリスナーも必ず止める
    Shared.clearSessionTimers(activeSession);
    detachActiveMedia();
    sessionGeneration += 1;
    activeSession = Shared.createVideoSession(sessionGeneration, videoId);
    return activeSession;
  }

  function discardSession() {
    Shared.clearSessionTimers(activeSession);
    detachActiveMedia();
    sessionGeneration += 1;
    activeSession = Shared.createVideoSession(sessionGeneration, null);
    currentVideoId = null;
  }

  function sessionMatches(session, videoRef) {
    if (!session || activeSession !== session) return false;
    return Shared.isCurrentSession(session, session.generation, videoRef);
  }

  function isOwnedVideoEvent(event) {
    const target = event?.currentTarget;
    if (!Shared.eventMatchesSession(activeSession, target)) return false;
    if (video !== target) return false;
    if (!currentVideoId || currentVideoId !== activeSession.videoId) return false;
    return true;
  }

  // イベントハンドラー（削除用に参照を保持）
  function handlePause(event) {
    if (!isOwnedVideoEvent(event)) return;
    savePositionOnPause();
  }

  function handleTimeUpdate(event) {
    if (!isOwnedVideoEvent(event)) return;
    if (isAdPlaying(event.currentTarget)) return;
    // 動画終了済みの場合は位置を更新しない
    if (hasEnded) return;

    const targetVideo = event.currentTarget;
    const currentTime = targetVideo.currentTime;
    const duration = targetVideo.duration;

    if (!isRestorableCurrentVideo(targetVideo)) return;
    if (!isValidPosition(currentTime)) return;
    if (!isPastMinimumSaveTime(currentTime)) return;

    // メモリに最新位置を不変スナップショットとして保持
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

  async function handleEnded(event) {
    if (event && !isOwnedVideoEvent(event)) return;
    if (isAdPlaying(event?.currentTarget || video)) return;

    // 動画終了時は保存データを削除
    if (!isExtensionValid()) return;
    hasEnded = true;
    const endedVideoId = currentVideoId;
    // 「最後まで見た動画を自動削除」がオフなら保存データを残す
    if (!settingsCache.autoDeleteWatched) {
      await saveWatchedPosition(endedVideoId, '動画終了', event?.currentTarget || video);
      return;
    }
    lastValidPosition = null;
    if (endedVideoId) {
      try {
        await chrome.storage.local.remove(getStorageKey(endedVideoId));
        console.log(`[YouTube再生位置保存] 動画終了: 保存データを削除`);
      } catch (e) {
        // 削除失敗でも hasEnded=true / lastValidPosition=null を維持し、再保存を抑止する
        console.warn('[YouTube再生位置保存] 動画終了時の削除失敗:', e.message || e);
      }
    }
  }

  function onVideoEnded(event) {
    void handleEnded(event);
  }

  function handleSeeked(event) {
    if (!isOwnedVideoEvent(event)) return;
    if (activeSession.isRestoring || isAdPlaying(event.currentTarget)) return;

    const targetVideo = event.currentTarget;
    if (hasEnded && isValidDuration(targetVideo.duration) && targetVideo.currentTime < targetVideo.duration - END_THRESHOLD_SEC) {
      hasEnded = false;
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

  function isAdPlaying(targetVideo) {
    const el = targetVideo || video;
    const player = el?.closest?.('.html5-video-player') || document.querySelector('.html5-video-player');
    return !!player?.classList.contains('ad-showing');
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

  function isRestorableCurrentVideo(targetVideo) {
    const el = targetVideo || video;
    return !!el && !isActiveLiveVideo() && isValidDuration(el.duration);
  }

  function isSavableCurrentVideo(targetVideo) {
    return isRestorableCurrentVideo(targetVideo) && !isAdPlaying(targetVideo);
  }

  function scheduleRestoreAfterAd(session, videoId) {
    if (!videoId || !session || session.restoreRetryTimerId) return;
    if (!sessionMatches(session)) return;

    const now = Date.now();
    if (!session.restoreRetryStartedAt) {
      session.restoreRetryStartedAt = now;
    }

    if (now - session.restoreRetryStartedAt > AD_RESTORE_MAX_WAIT_MS) {
      session.restoreRetryStartedAt = 0;
      console.log('[YouTube再生位置保存] 広告終了待ちがタイムアウトしたため復元をスキップ');
      return;
    }

    session.restoreRetryTimerId = setTimeout(async () => {
      session.restoreRetryTimerId = null;

      if (!sessionMatches(session) || currentVideoId !== videoId || !video) {
        session.restoreRetryStartedAt = 0;
        return;
      }

      if (isAdPlaying()) {
        scheduleRestoreAfterAd(session, videoId);
        return;
      }

      session.restoreRetryStartedAt = 0;
      try {
        await restorePosition(session);
      } catch (e) {
        console.warn('[YouTube再生位置保存] 広告後の復元リトライ失敗:', e.message || e);
      }
    }, AD_RESTORE_RETRY_MS);
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

  function pauseForRestore(session, targetVideo) {
    if (!sessionMatches(session, targetVideo)) return;
    const el = targetVideo;
    if (!el) return;
    if (!el.paused) {
      session.pausedForPendingRestore = true;
    }
    el.pause();
  }

  // セッション不一致時はグローバル/新セッション状態を変更せず return する
  function finishRestore(session, options = {}) {
    const { resumeIfPaused = false, targetVideo = null } = options;
    const result = Shared.finishSessionRestore(session, activeSession, { resumeIfPaused });
    if (!result.applied) return;

    if (result.shouldResume && targetVideo && targetVideo.paused) {
      targetVideo.play().catch((e) => {
        console.warn('[YouTube再生位置保存] 復元スキップ後の再生再開がブロックされました:', e.message || e);
      });
    }
  }

  // 再生位置を保存（共通ロジック）
  async function savePositionCore(targetVideoId, options = {}) {
    const { skipPauseCheck = false, targetVideo = video, session = activeSession } = options;

    // 定期保存（saveIntervalId）が orphan の主な心拍。無効を検知したら自己停止する。
    if (stopIfExtensionInvalid()) return;
    if (settingsLoadFailed || settingsCache.enabled === false) return;
    if (!targetVideo || !targetVideoId) return;
    if (!sessionMatches(session, targetVideo)) return;
    if (currentVideoId !== targetVideoId || session.videoId !== targetVideoId) return;

    // 復元中は保存しない
    if (session.isRestoring) return;

    // 広告中は広告動画の位置・長さを保存しない
    if (isAdPlaying(targetVideo)) return;

    // 動画終了済みの場合は保存しない（ended後のSPA遷移で再保存されるのを防止）
    if (hasEnded) return;

    // 一時停止中は保存しない（定期保存の重複防止、オプションでスキップ可能）
    if (!skipPauseCheck && targetVideo.paused) return;

    const currentTime = targetVideo.currentTime;
    const duration = targetVideo.duration;

    // 無効な値の場合は保存しない
    if (!isSavableCurrentVideo(targetVideo)) return;
    if (!isValidPosition(currentTime)) return;
    if (!isPastMinimumSaveTime(currentTime)) return;

    // 動画の終わり付近（残り END_THRESHOLD_SEC 秒以内）の場合
    // （endedイベントが発火しないケースへの対策）
    if (currentTime >= duration - END_THRESHOLD_SEC) {
      // 終了扱いにして以後の再保存を止める（自動削除オフなら末尾位置を保持する）
      hasEnded = true;
      // 「最後まで見た動画を自動削除」がオフなら保存データを残す
      if (!settingsCache.autoDeleteWatched) {
        await saveWatchedPosition(targetVideoId, '動画終了付近', targetVideo);
        return;
      }
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

  async function saveWatchedPosition(targetVideoId, reason, targetVideo = video) {
    if (!targetVideo || !targetVideoId || isAdPlaying(targetVideo)) return;

    const duration = targetVideo.duration;
    const currentTime = targetVideo.currentTime;
    if (!isValidDuration(duration) || !isValidPosition(currentTime)) return;

    const data = {
      position: Math.min(currentTime, duration),
      duration: duration,
      timestamp: Date.now(),
      title: document.title
    };

    lastValidPosition = { videoId: targetVideoId, data: data };

    try {
      await chrome.storage.local.set({ [getStorageKey(targetVideoId)]: data });
      console.log(`[YouTube再生位置保存] ${reason}: 保存データを保持`);
    } catch (e) {
      console.warn(`[YouTube再生位置保存] ${reason}の保存失敗:`, e.message || e);
    }
  }

  // 再生位置を保存（定期保存用）
  function savePosition() {
    const session = activeSession;
    const targetVideo = session?.videoRef;
    const targetVideoId = session?.videoId;
    if (!targetVideo || !targetVideoId || video !== targetVideo || currentVideoId !== targetVideoId) {
      return;
    }
    // 定期的にライブ判定を最新化（timeupdate / 各保存はこのキャッシュを参照する）
    updateLiveStatus();
    savePositionCore(targetVideoId, { skipPauseCheck: false, targetVideo, session });
  }

  // 一時停止時の保存（pauseチェックなし）
  function savePositionOnPause() {
    const session = activeSession;
    const targetVideo = session?.videoRef;
    const targetVideoId = session?.videoId;
    if (!targetVideo || !targetVideoId || video !== targetVideo || currentVideoId !== targetVideoId) {
      return;
    }
    savePositionCore(targetVideoId, { skipPauseCheck: true, targetVideo, session });
  }

  // メモリに保持した最後の位置を保存（ページ遷移時用）
  async function saveLastValidPosition(snapshot) {
    if (!isExtensionValid()) return;
    if (!snapshot) return;

    try {
      await chrome.storage.local.set({ [getStorageKey(snapshot.videoId)]: snapshot.data });
      console.log(`[YouTube再生位置保存] 遷移時保存: ${Math.floor(snapshot.data.position)}秒`);
    } catch (e) {
      console.warn('[YouTube再生位置保存] 遷移時保存失敗:', e.message || e);
    }
  }

  // 遷移/非表示/離脱時の保存を統一（popstate等の相性改善）
  // 可変な video 要素ではなく、timeupdate 時点の不変スナップショットを優先する
  async function saveForNavigation() {
    const snapshot = lastValidPosition;
    try {
      await saveLastValidPosition(snapshot);
    } finally {
      // await 中に新しいスナップショットへ更新されても、旧処理は新しい値を消さない
      lastValidPosition = Shared.clearSnapshotIfSame(lastValidPosition, snapshot);
    }
  }

  function getRestoreContext(session) {
    const targetVideoId = session?.videoId || null;
    const targetVideo = session?.videoRef || null;
    const storageKey = targetVideoId ? getStorageKey(targetVideoId) : null;
    return { targetVideoId, targetVideo, storageKey };
  }

  // 世代不一致時は状態を触らず aborted。現セッションなら finish/continue を返す
  function guardRestoreSession(session, targetVideo, options = {}) {
    const { finishOnMatch = false, resumeIfPaused = false } = options;
    if (!sessionMatches(session, targetVideo)) {
      return 'aborted';
    }
    if (finishOnMatch) {
      finishRestore(session, { resumeIfPaused, targetVideo });
      return 'finished';
    }
    return 'continue';
  }

  async function loadStoredRestoreData(session, context) {
    const { targetVideo, storageKey } = context;
    if (!isExtensionValid()) {
      finishRestore(session, { resumeIfPaused: true, targetVideo });
      return { status: 'finished' };
    }

    const result = await chrome.storage.local.get(storageKey);
    if (guardRestoreSession(session, targetVideo) === 'aborted') {
      return { status: 'aborted' };
    }

    const data = result[storageKey];
    if (!data || !data.position) {
      finishRestore(session, { resumeIfPaused: true, targetVideo });
      return { status: 'finished' };
    }

    return { status: 'continue', data };
  }

  async function validateRestoreCandidate(session, context, data) {
    const { targetVideoId, targetVideo } = context;

    if (!isValidStoredPosition(data)) {
      await removeStoredPosition(targetVideoId, '無効な保存データ');
      guardRestoreSession(session, targetVideo, { finishOnMatch: true, resumeIfPaused: true });
      return 'finished';
    }

    updateLiveStatus();
    if (guardRestoreSession(session, targetVideo) === 'aborted') {
      return 'aborted';
    }

    if (isAdPlaying(targetVideo)) {
      console.log('[YouTube再生位置保存] 広告中のため復元を延期');
      scheduleRestoreAfterAd(session, targetVideoId);
      finishRestore(session, { resumeIfPaused: true, targetVideo });
      return 'finished';
    }

    if (!isRestorableCurrentVideo(targetVideo)) {
      await removeStoredPosition(targetVideoId, 'ライブ配信または無効な動画長');
      guardRestoreSession(session, targetVideo, { finishOnMatch: true, resumeIfPaused: true });
      return 'finished';
    }

    if (Math.abs(targetVideo.duration - data.duration) > DURATION_DIFF_THRESHOLD) {
      console.log(`[YouTube再生位置保存] 動画の長さが異なるため復元をスキップ`);
      finishRestore(session, { resumeIfPaused: true, targetVideo });
      return 'finished';
    }

    return guardRestoreSession(session, targetVideo);
  }

  function waitForSeeked(targetVideo) {
    return new Promise((resolve) => {
      let settled = false;
      const handleSeekedOnce = () => {
        if (settled) return;
        settled = true;
        targetVideo.removeEventListener('seeked', handleSeekedOnce);
        resolve();
      };
      targetVideo.addEventListener('seeked', handleSeekedOnce);
      setTimeout(() => {
        if (!settled) {
          settled = true;
          targetVideo.removeEventListener('seeked', handleSeekedOnce);
          console.log('[YouTube再生位置保存] seeked タイムアウト: フォールバックで続行');
          resolve();
        }
      }, SEEKED_TIMEOUT_MS);
    });
  }

  async function seekToStoredPosition(session, context, data) {
    const { targetVideo } = context;
    session.isRestoring = true;
    pauseForRestore(session, targetVideo);
    targetVideo.currentTime = data.position;
    await waitForSeeked(targetVideo);
    return guardRestoreSession(session, targetVideo);
  }

  function completeRestore(session, context, data) {
    const { targetVideo } = context;

    if (settingsCache.autoPlayOnRestore) {
      targetVideo.play().catch((e) => {
        console.warn('[YouTube再生位置保存] 自動再生がブロックされました:', e.message || e);
      });
    }

    finishRestore(session, { targetVideo });
    console.log(`[YouTube再生位置保存] 復元: ${Math.floor(data.position)}秒から再開`);

    if (settingsCache.notifyOnRestore) {
      const messageTemplate = chrome.i18n.getMessage('notificationResumeAt') || '{position}秒から再開します';
      showNotification(messageTemplate.replace('{position}', Math.floor(data.position)));
    }
  }

  // 保存された再生位置を復元（ステップ分割。各 await 後に世代ガード）
  async function restorePosition(session = activeSession) {
    const context = getRestoreContext(session);
    const { targetVideoId, targetVideo, storageKey } = context;

    if (!targetVideo || !targetVideoId || !storageKey) {
      if (sessionMatches(session, targetVideo)) {
        finishRestore(session, { resumeIfPaused: true, targetVideo });
      }
      return;
    }

    // 世代不一致時は新セッションの復元状態を触らず終了する
    if (!sessionMatches(session, targetVideo)) {
      return;
    }

    try {
      const loaded = await loadStoredRestoreData(session, context);
      if (loaded.status !== 'continue') return;

      const validated = await validateRestoreCandidate(session, context, loaded.data);
      if (validated !== 'continue') return;

      const sought = await seekToStoredPosition(session, context, loaded.data);
      if (sought !== 'continue') return;

      completeRestore(session, context, loaded.data);
    } catch (e) {
      if (sessionMatches(session, targetVideo)) {
        finishRestore(session, { resumeIfPaused: true, targetVideo });
      }
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
    if (settingsLoadFailed || settingsCache.enabled === false) {
      stopSaving();
      return;
    }
    if (saveIntervalId) {
      clearInterval(saveIntervalId);
    }
    const intervalMs = Shared.getSaveIntervalMs(settingsCache);
    saveIntervalId = setInterval(savePosition, intervalMs);
  }

  // 定期保存を停止
  function stopSaving() {
    if (saveIntervalId) {
      clearInterval(saveIntervalId);
      saveIntervalId = null;
    }
  }

  // 動画のイベントリスナーをクリーンアップ
  function cleanupVideoListeners() {
    if (video) {
      video.removeEventListener('pause', handlePause);
      video.removeEventListener('timeupdate', handleTimeUpdate);
      video.removeEventListener('ended', onVideoEnded);
      video.removeEventListener('seeked', handleSeeked);
    }
  }

  // 動画要素を取得してセットアップ
  function setupVideo(session) {
    const newVideo = document.querySelector('video.html5-main-video');
    if (!newVideo) return false;

    // 同じ動画要素の場合はスキップ
    if (video === newVideo) {
      if (session) session.videoRef = newVideo;
      return true;
    }

    // 前のリスナーを削除
    cleanupVideoListeners();

    video = newVideo;
    if (session) session.videoRef = newVideo;

    // イベントリスナーを設定
    video.addEventListener('pause', handlePause);
    video.addEventListener('timeupdate', handleTimeUpdate);
    video.addEventListener('ended', onVideoEnded);
    video.addEventListener('seeked', handleSeeked);

    return true;
  }

  function startVideoCheck(session, onReady) {
    Shared.clearSessionTimers(session);

    const tick = async () => {
      if (!sessionMatches(session)) {
        Shared.clearSessionTimers(session);
        return;
      }

      if (setupVideo(session)) {
        Shared.clearSessionTimers(session);
        if (!sessionMatches(session, session.videoRef)) return;
        await onReady(session);
      }
    };

    session.checkIntervalId = setInterval(() => {
      void tick();
    }, VIDEO_CHECK_INTERVAL_MS);

    session.checkTimeoutId = setTimeout(() => {
      if (!sessionMatches(session)) return;
      if (session.checkIntervalId) {
        clearInterval(session.checkIntervalId);
        session.checkIntervalId = null;
      }
      session.checkTimeoutId = null;
    }, VIDEO_CHECK_TIMEOUT_MS);

    void tick();
  }

  // 設定を読み込み（失敗時は最後の検証済みキャッシュを維持し、保存を停止）
  async function loadSettings() {
    try {
      const result = await chrome.storage.local.get(SETTINGS_KEY);
      settingsCache = Shared.normalizeSettings(result[SETTINGS_KEY]);
      settingsLoadFailed = false;
      return { ok: true, settings: settingsCache };
    } catch (e) {
      settingsLoadFailed = true;
      stopSaving();
      console.warn('[YouTube再生位置保存] 設定読込失敗のため保存を停止:', e.message || e);
      return { ok: false, settings: settingsCache };
    }
  }

  // 設定の有効/無効をチェック
  async function isEnabled() {
    const { ok, settings } = await loadSettings();
    if (!ok) return false;
    return settings.enabled !== false;
  }

  async function prepareAndRestore(session) {
    if (!sessionMatches(session, session.videoRef)) return;

    updateLiveStatus();

    if (stopIfExtensionInvalid()) return;

    const capturedVideoId = session.videoId;
    const storageKey = getStorageKey(capturedVideoId);
    let hasRestorableStoredPosition = false;
    try {
      const result = await chrome.storage.local.get(storageKey);
      if (!sessionMatches(session, session.videoRef)) return;
      hasRestorableStoredPosition = isValidStoredPosition(result[storageKey]) && !isActiveLiveVideo();
    } catch (e) {
      console.warn('[YouTube再生位置保存] 保存データ確認失敗:', e.message || e);
    }

    if (!sessionMatches(session, session.videoRef)) return;

    // 復元可能な保存データがある場合は復元前の保存を抑止してから一時停止
    // （pause イベントで現在位置=0付近が保存され、復元データを上書きするのを防ぐ）
    if (hasRestorableStoredPosition && !isAdPlaying(session.videoRef)) {
      session.isRestoring = true;
      pauseForRestore(session, session.videoRef);
    }

    const targetVideo = session.videoRef;
    if (targetVideo.readyState >= 1) {
      await restorePosition(session);
      if (sessionMatches(session, targetVideo)) startSaving();
    } else {
      targetVideo.addEventListener('loadedmetadata', async () => {
        if (!sessionMatches(session, targetVideo)) return;
        await restorePosition(session);
        if (sessionMatches(session, targetVideo)) startSaving();
      }, { once: true });
    }
  }

  // メイン処理（requestId で並行 init の完了順逆転を抑止）
  async function init(requestId) {
    // orphan（拡張コンテキストが無効化された旧インスタンス）はここで自己停止する
    // （「動画検出」ログや動画チェック用 setInterval を無駄に起動しないため）
    if (stopIfExtensionInvalid()) return;
    if (!isCurrentInitRequest(requestId)) return;

    // 設定で無効化されている場合、または読込失敗時は停止
    if (!(await isEnabled())) {
      if (!isCurrentInitRequest(requestId)) return;
      stopSaving();
      discardSession();
      return;
    }
    if (!isCurrentInitRequest(requestId)) return;

    const videoId = getVideoId();

    // 動画ページでない場合は何もしない
    if (!videoId) {
      stopSaving();
      discardSession();
      return;
    }

    // 同じ動画でも <video> が再作成されている場合はリスナーを張り直す
    if (videoId === currentVideoId && activeSession.videoId === videoId) {
      const session = activeSession;
      if (setupVideo(session)) {
        updateLiveStatus();
        if (!saveIntervalId) startSaving();
      } else {
        startVideoCheck(session, async (readySession) => {
          if (!sessionMatches(readySession, readySession.videoRef)) return;
          updateLiveStatus();
          if (!saveIntervalId) startSaving();
        });
      }
      return;
    }

    // 遷移時はスナップショットを保存してから新セッションへ
    // beginSession 内で定期保存停止・旧リスナー解除を行い、currentVideoId 更新前に旧経路を閉じる
    await saveForNavigation();
    if (!isCurrentInitRequest(requestId)) return;

    // await 中に URL が変わっていれば、より新しい init に任せる
    if (getVideoId() !== videoId) return;

    const session = beginSession(videoId);
    currentVideoId = videoId;
    hasEnded = false; // 新しい動画への遷移時にリセット
    isLiveCached = false; // 前の動画のライブ判定を引き継がない（既定は復元対象＝非ライブ）
    console.log(`[YouTube再生位置保存] 動画検出: ${videoId}`);

    startVideoCheck(session, prepareAndRestore);
  }

  function handleBeforeUnload() {
    void saveForNavigation();
  }

  function handleYtNavigateFinish() {
    lastNavigateFinishAt = Date.now();
    void saveForNavigation();
    scheduleInit(0);
  }

  function handlePopState() {
    void saveForNavigation();

    // yt-navigate-finish直後のpopstateは二重初期化になりやすいので抑止
    const now = Date.now();
    if (now - lastNavigateFinishAt < 250) return;

    scheduleInit(POPSTATE_INIT_DELAY_MS);
  }

  function handleVisibilityChange() {
    if (document.hidden) {
      void saveForNavigation();
    }
  }

  function handleSettingsChanged(changes, areaName) {
    if (areaName !== 'local' || !changes[SETTINGS_KEY]) return;

    settingsCache = Shared.normalizeSettings(changes[SETTINGS_KEY].newValue);
    settingsLoadFailed = false;

    if (settingsCache.enabled === false) {
      // 実行中/保留中の init を失効させてからセッションを破棄する
      invalidateInitRequests();
      stopSaving();
      discardSession();
      return;
    }

    // 保存中なら新しい保存間隔で張り替える
    // （init() は同じ動画だと早期 return するため、ここで明示的に再起動する）
    if (saveIntervalId) {
      startSaving();
    }

    scheduleInit(0);
  }

  function handleRuntimeMessage(message, _sender, sendResponse) {
    if (message && message.type === PING_MESSAGE_TYPE) {
      sendResponse({ ok: true, version: CONTENT_SCRIPT_VERSION });
      return false;
    }
    return false;
  }

  function cleanupContentScript() {
    // 実行中/保留中の init を無効化し、cleanup 後の beginSession を防ぐ
    invalidateInitRequests();
    stopSaving();
    Shared.clearSessionTimers(activeSession);
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

    try {
      chrome.runtime.onMessage.removeListener(handleRuntimeMessage);
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
  chrome.runtime.onMessage.addListener(handleRuntimeMessage);

  // 初期化
  scheduleInit(0);

})();
