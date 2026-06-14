// YouTube 再生位置自動保存 拡張機能
(function () {
  'use strict';

  // 多重注入防止（SW による再注入時に二重起動しない）
  if (window.__ytPositionSaverLoaded) return;
  window.__ytPositionSaverLoaded = true;

  // 起動マーカー（読み込まれているコードのバージョン確認用）
  console.log('[YouTube再生位置保存] 起動 v1.6.5');

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
  const SEEKED_TIMEOUT_MS = 3000; // seeked イベントのタイムアウト（ms）
  const SETTINGS_KEY = 'yt_position_settings'; // 設定用ストレージキー
  const END_THRESHOLD_SEC = 3; // 動画終了判定の閾値（秒）

  let currentVideoId = null;
  let saveIntervalId = null;
  let videoCheckIntervalId = null; // 動画チェック用インターバルID
  let video = null;
  let lastValidPosition = null; // 最後の有効な再生位置をメモリに保持
  let isRestoring = false; // 復元中フラグ（イベント競合防止）
  let hasEnded = false; // 動画終了済みフラグ（ended後の再保存防止）
  let pausedForPendingRestore = false; // 復元準備で一時停止したかどうか
  let isLiveCached = false; // 配信中ライブかのキャッシュ（timeupdate毎のDOM計測を避ける）
  let liveCleanupDone = false; // ライブ検出時の古い保存データ削除を一度だけ行うフラグ

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

  function getLiveStatusFromMainWorld(videoId) {
    return new Promise((resolve) => {
      const script = document.createElement('script');

      const listener = (event) => {
        if (event.source !== window || !event.data || event.data.type !== 'YtPosSaver_LiveInfo_Response') return;
        window.removeEventListener('message', listener);
        script.remove();
        console.log('[YouTube再生位置保存-Isolated] MainWorldからの返答:', event.data);
        if (event.data.error || !event.data.videoId || event.data.videoId !== videoId) {
          resolve(null); // エラーまたは動画ID不一致の場合は判定不能（null）として扱う
        } else {
          resolve(event.data.isLive);
        }
      };

      window.addEventListener('message', listener);

      script.src = chrome.runtime.getURL('main_world.js');
      document.documentElement.appendChild(script);

      // フォールバック用のタイムアウト
      setTimeout(() => {
        window.removeEventListener('message', listener);
        script.remove();
        console.log('[YouTube再生位置保存-Isolated] MainWorldからの応答がタイムアウトしました');
        resolve(null);
      }, 1000); // 念のためタイムアウトを1000msに延長
    });
  }

  // 配信中ライブかどうかを判定する。
  // ※DVR有効ライブは video.duration が有限値になるため duration だけでは判別できず、この判定が必須。
  function detectActiveLiveFromDom() {
    // DOMのUIシグナルから判定
    // ・経過時間表示に .ytp-live クラスが付く（クラス判定＝リフロー不要・比較的早期に付与される）
    // ・プレイヤーの「ライブ」バッジが可視（VOD・アーカイブでは display:none）
    const timeDisplay = document.querySelector('.ytp-time-display');
    if (timeDisplay && timeDisplay.classList.contains('ytp-live')) return true;

    return isVisibleElement(document.querySelector('.ytp-live-badge'));
  }

  // ライブ判定を再評価してキャッシュを更新する（DOM 計測はここでのみ行う）。
  // 一度ライブと判定したら、その動画セッションの間は維持する（sticky-for-true）。
  // 理由：YouTubeプレイヤーはユーザ操作後にコントロールバー（バッジ含む）を
  // 自動非表示するため、ライブ視聴中でも DOM 上の可視シグナルが一時的に消える。
  // 再生中に「ライブ→VOD」（あるいは逆）に変わることは無いので、true を維持して
  // 「コントロール非表示→誤ってVOD扱い→保存→次回 livehead から大きく後ろに復元→停止」
  // という連鎖故障を防ぐ。
  function updateLiveStatus() {
    if (isLiveCached) return true;
    isLiveCached = detectActiveLiveFromDom();
    return isLiveCached;
  }

  // 配信中ライブか（キャッシュ参照。timeupdate などのホットパスから安全に呼べる）
  function isActiveLiveVideo() {
    return isLiveCached;
  }

  // プレイヤーのコントロールUI（時刻表示）が描画済みか。
  // これが現れて初めて detectActiveLiveFromDom の結果が信頼できる
  // （読込直後は video 要素だけ先に使えるようになり、ライブバッジ／時刻表示の
  //   描画は少し遅れるため、早すぎる判定はライブを取りこぼす）。
  function isPlayerChromeReady() {
    return !!document.querySelector('.ytp-time-display');
  }

  // ライブ判定を「信頼できるタイミング」まで待ってから確定する。
  // 読込直後は video 要素が先に使えるようになり、ライブバッジ／時刻表示の描画が
  // 遅れることがある。その隙にライブを「非ライブ」と誤判定して一時停止すると、
  // ライブ配信が「一瞬再生→停止」のまま取り残される（本不具合の根本原因）。
  // これを防ぐため復元判定の直前にだけ呼び、次のいずれかで確定する：
  // ・ライブを積極的に検出できたら即座に true
  // ・プレイヤーUIが描画され、少し待っても非ライブのままなら false（＝VOD確定）
  // ・想定外に長引いた場合はタイムアウトして最終判定
  // いずれの経路でも isLiveCached を最新化するので、呼び出し後は isActiveLiveVideo() が使える。
  async function resolveLiveStatus({ maxWaitMs = 2500, settleMs = 150 } = {}) {
    console.log('[YouTube再生位置保存] resolveLiveStatus開始');
    // 1. まず Main World の ytInitialPlayerResponse から確実なライブ情報を非同期取得してみる
    // これが最も正確で、パース失敗や DOMの遅延による誤判定の影響を受けない
    const isLiveFromMain = await getLiveStatusFromMainWorld(currentVideoId);
    console.log('[YouTube再生位置保存] getLiveStatusFromMainWorldの結果:', isLiveFromMain);
    if (isLiveFromMain === true) {
      isLiveCached = true;
      return true;
    } else if (isLiveFromMain === false) {
      return false; // VOD確定（動画IDが一致し、isLiveContentが false であることが明確）
    }

    console.log('[YouTube再生位置保存] DOMUIシグナルによるフォールバック判定を開始');
    // 2. DOMUIシグナルによる判定（SPA遷移後などで Main World から情報が得られなかった場合のフォールバック）
    const start = Date.now();
    let chromeReadyAt = null;
    while (Date.now() - start < maxWaitMs) {
      if (updateLiveStatus()) {
        console.log('[YouTube再生位置保存] DOM判定でライブ確定');
        return true; // 積極的にライブ検出できた → 確定
      }
      if (isPlayerChromeReady()) {
        if (chromeReadyAt === null) chromeReadyAt = Date.now();
        // UI描画直後はライブ用クラス付与が一瞬遅れる場合に備え、ごく短く待ってから確定
        if (Date.now() - chromeReadyAt >= settleMs) {
          console.log('[YouTube再生位置保存] DOM判定でVOD確定 (settleMs経過)');
          return false; // VOD確定
        }
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    const finalStatus = updateLiveStatus();
    console.log('[YouTube再生位置保存] DOM判定タイムアウトによる最終判定:', finalStatus);
    return finalStatus; // フォールバック（最終判定）
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
    // 拡張側が復元目的で一時停止したものは、復元をスキップした場合に必ず再生へ戻す。
    // ライブ等で読み込み直後にまだ自動再生が始まっておらず video.paused===true でも、
    // 取り残して「一時停止のまま」になるのを防ぐため、常に再開対象として記録する。
    pausedForPendingRestore = true;
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

    if (!isExtensionValid()) return;
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

    // 動画の終わり付近（残り END_THRESHOLD_SEC 秒以内）の場合は保存データを削除
    // （endedイベントが発火しないケースへの対策）
    if (currentTime >= duration - END_THRESHOLD_SEC) {
      hasEnded = true;
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

    if (isActiveLiveVideo()) {
      // ライブは保存対象外。旧バージョンが保存した古いデータが残っていると
      // 再読み込み時に不要な復元処理（一時停止）が走るため、検出時に一度だけ削除する。
      if (!liveCleanupDone && currentVideoId) {
        liveCleanupDone = true;
        removeStoredPosition(currentVideoId, 'ライブ検出により古い保存データを削除');
      }
      return;
    }

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

        // ライブ判定が信頼できるタイミングまで待ってから復元可否を判定する。
        // （読込直後にUI未描画でライブを誤判定し、一時停止で取り残すのを防ぐ）
        await resolveLiveStatus();
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

        // 復元完了、再生開始
        video.play().catch((e) => {
          console.warn('[YouTube再生位置保存] 自動再生がブロックされました:', e.message || e);
        });

        // 復元中フラグを解除
        finishRestore();

        console.log(`[YouTube再生位置保存] 復元: ${Math.floor(data.position)}秒から再開`);

        // 復元完了を通知（トースト表示）
        showNotification(`${Math.floor(data.position)}秒から再開します`);
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

  // 設定の有効/無効をチェック
  async function isEnabled() {
    try {
      const result = await chrome.storage.local.get(SETTINGS_KEY);
      const settings = result[SETTINGS_KEY];
      return !settings || settings.enabled !== false;
    } catch (e) {
      return true; // 取得失敗時はデフォルト有効
    }
  }

  // メイン処理
  async function init() {
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
    liveCleanupDone = false;
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

        // メタデータ読み込み後に実行する共通処理
        const processRestoreAndStartSaving = async () => {
          if (currentVideoId !== capturedVideoId) return;

          // ライブ判定を最新化（動画のメタデータが読み込まれ、UIが構築され始めるのを待ってから判定）
          await resolveLiveStatus();

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

          // 復元可能な保存データがある場合は復元前の保存を抑止する（isRestoring=true）。
          // 実際の一時停止は restorePosition がシーク直前にのみ行う。
          if (hasRestorableStoredPosition) {
            isRestoring = true;
            await restorePosition();
          }
          startSaving();
        };

        // 動画のメタデータが読み込まれてから判定と復元を行う
        if (video.readyState >= 1) {
          await processRestoreAndStartSaving();
        } else {
          video.addEventListener('loadedmetadata', async () => {
            await processRestoreAndStartSaving();
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
