// YouTube 再生位置自動保存 - 共有スキーマ検証
(function (root) {
  'use strict';

  const YOUTUBE_VIDEO_ID_PATTERN = /^[a-zA-Z0-9_-]{11}$/;
  const MAX_TITLE_LENGTH = 500;
  const MAX_IMPORT_BYTES = 5 * 1024 * 1024;
  const MAX_IMPORT_RECORDS = 5000;
  const POSITION_DURATION_EPSILON = 1;

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

  const ALLOWED_MIN_SAVE_SECONDS = new Set([0, 10, 30, 60]);
  const ALLOWED_SAVE_INTERVAL_SECONDS = new Set([5, 10, 30]);
  const ALLOWED_AUTO_CLEANUP_DAYS = new Set([0, 30, 90, 180]);
  const ALLOWED_OPEN_VIDEO_MODE = new Set(['existing', 'new']);

  function isFiniteNonNegative(value) {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0;
  }

  function isValidVideoId(videoId) {
    return typeof videoId === 'string' && YOUTUBE_VIDEO_ID_PATTERN.test(videoId);
  }

  function pickBoolean(value, fallback) {
    return typeof value === 'boolean' ? value : fallback;
  }

  function pickAllowedNumber(value, allowed, fallback) {
    const num = typeof value === 'number' ? value : Number(value);
    return allowed.has(num) ? num : fallback;
  }

  function pickAllowedString(value, allowed, fallback) {
    return typeof value === 'string' && allowed.has(value) ? value : fallback;
  }

  function normalizeTitle(title, videoId) {
    if (typeof title !== 'string') {
      return videoId || '';
    }
    const trimmed = title.trim();
    if (!trimmed) return videoId || '';
    return trimmed.length > MAX_TITLE_LENGTH ? trimmed.slice(0, MAX_TITLE_LENGTH) : trimmed;
  }

  function normalizeSettings(raw) {
    const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    return {
      enabled: pickBoolean(source.enabled, DEFAULT_SETTINGS.enabled),
      notifyOnRestore: pickBoolean(source.notifyOnRestore, DEFAULT_SETTINGS.notifyOnRestore),
      autoPlayOnRestore: pickBoolean(source.autoPlayOnRestore, DEFAULT_SETTINGS.autoPlayOnRestore),
      minSaveSeconds: pickAllowedNumber(source.minSaveSeconds, ALLOWED_MIN_SAVE_SECONDS, DEFAULT_SETTINGS.minSaveSeconds),
      autoDeleteWatched: pickBoolean(source.autoDeleteWatched, DEFAULT_SETTINGS.autoDeleteWatched),
      saveIntervalSeconds: pickAllowedNumber(
        source.saveIntervalSeconds,
        ALLOWED_SAVE_INTERVAL_SECONDS,
        DEFAULT_SETTINGS.saveIntervalSeconds
      ),
      autoCleanupDays: pickAllowedNumber(source.autoCleanupDays, ALLOWED_AUTO_CLEANUP_DAYS, DEFAULT_SETTINGS.autoCleanupDays),
      openVideoMode: pickAllowedString(source.openVideoMode, ALLOWED_OPEN_VIDEO_MODE, DEFAULT_SETTINGS.openVideoMode)
    };
  }

  function validateVideoRecord(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
    if (!isValidVideoId(raw.videoId)) return false;
    if (!isFiniteNonNegative(Number(raw.position))) return false;
    if (!isFiniteNonNegative(Number(raw.duration))) return false;
    if (!isFiniteNonNegative(Number(raw.timestamp))) return false;

    const position = Number(raw.position);
    const duration = Number(raw.duration);
    if (duration < 1) return false;
    if (position > duration + POSITION_DURATION_EPSILON) return false;
    if (raw.title != null && typeof raw.title !== 'string') return false;
    return true;
  }

  function normalizeVideoRecord(raw) {
    if (!validateVideoRecord(raw)) return null;

    const videoId = raw.videoId;
    const position = Number(raw.position);
    const duration = Number(raw.duration);
    const timestamp = Number(raw.timestamp);

    return {
      videoId,
      position,
      duration,
      timestamp,
      title: normalizeTitle(raw.title, videoId)
    };
  }

  function parseImportPayload(text, byteLength) {
    if (typeof byteLength === 'number' && byteLength > MAX_IMPORT_BYTES) {
      throw new Error('Import file too large');
    }
    if (typeof text !== 'string' || !text) {
      throw new Error('Invalid import file');
    }
    if (text.length > MAX_IMPORT_BYTES) {
      throw new Error('Import file too large');
    }

    let payload;
    try {
      payload = JSON.parse(text);
    } catch (e) {
      throw new Error('Invalid import file');
    }

    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new Error('Invalid import file');
    }

    // version 1 のみ受理（将来の移行処理の骨格）
    if (payload.version != null && payload.version !== 1) {
      throw new Error('Unsupported import version');
    }

    const videos = Array.isArray(payload.videos) ? payload.videos : [];
    if (videos.length > MAX_IMPORT_RECORDS) {
      throw new Error('Too many import records');
    }

    const normalizedVideos = [];
    for (const video of videos) {
      const normalized = normalizeVideoRecord(video);
      if (normalized) normalizedVideos.push(normalized);
    }

    const hasSettings = payload.settings && typeof payload.settings === 'object' && !Array.isArray(payload.settings);
    const settings = hasSettings ? normalizeSettings(payload.settings) : null;

    if (normalizedVideos.length === 0 && !settings) {
      throw new Error('Invalid import file');
    }

    return {
      version: 1,
      settings,
      videos: normalizedVideos
    };
  }

  function getSaveIntervalMs(settings) {
    const normalized = normalizeSettings(settings);
    return normalized.saveIntervalSeconds * 1000;
  }

  function isCurrentSession(session, generation, videoRef) {
    if (!session) return false;
    if (session.generation !== generation) return false;
    if (videoRef != null && session.videoRef !== videoRef) return false;
    return true;
  }

  function createVideoSession(generation, videoId) {
    return {
      generation,
      videoId: videoId || null,
      videoRef: null,
      checkIntervalId: null,
      checkTimeoutId: null,
      restoreRetryTimerId: null,
      restoreRetryStartedAt: 0,
      isRestoring: false,
      pausedForPendingRestore: false
    };
  }

  function clearSessionTimers(session) {
    if (!session) return;
    if (session.checkIntervalId) {
      clearInterval(session.checkIntervalId);
      session.checkIntervalId = null;
    }
    if (session.checkTimeoutId) {
      clearTimeout(session.checkTimeoutId);
      session.checkTimeoutId = null;
    }
    if (session.restoreRetryTimerId) {
      clearTimeout(session.restoreRetryTimerId);
      session.restoreRetryTimerId = null;
    }
    session.restoreRetryStartedAt = 0;
  }

  // イベントが現在セッションの videoRef に紐づくか
  function eventMatchesSession(session, eventTarget) {
    return !!session && !!eventTarget && session.videoRef === eventTarget;
  }

  // ナビゲーション保存用: 捕捉したスナップショットと同一参照のときだけクリアする
  function clearSnapshotIfSame(currentSnapshot, capturedSnapshot) {
    return currentSnapshot === capturedSnapshot ? null : currentSnapshot;
  }

  // 旧セッションの復元完了処理が新セッションを触らないようにする
  function canMutateSessionRestoreState(session, activeSession) {
    return !!session && session === activeSession;
  }

  function finishSessionRestore(session, activeSession, options = {}) {
    if (!canMutateSessionRestoreState(session, activeSession)) {
      return { applied: false, shouldResume: false };
    }

    const { resumeIfPaused = false } = options;
    const shouldResume = resumeIfPaused && session.pausedForPendingRestore;
    session.isRestoring = false;
    if (!resumeIfPaused) {
      session.pausedForPendingRestore = false;
    } else {
      session.pausedForPendingRestore = false;
    }

    return { applied: true, shouldResume };
  }

  // 並行 init の完了順逆転を防ぐ: requestId が最新のときだけ続行する
  function isLatestInitRequest(requestId, latestRequestId) {
    return requestId === latestRequestId;
  }

  const api = {
    DEFAULT_SETTINGS,
    YOUTUBE_VIDEO_ID_PATTERN,
    MAX_TITLE_LENGTH,
    MAX_IMPORT_BYTES,
    MAX_IMPORT_RECORDS,
    isValidVideoId,
    normalizeSettings,
    validateVideoRecord,
    normalizeVideoRecord,
    parseImportPayload,
    getSaveIntervalMs,
    isCurrentSession,
    createVideoSession,
    clearSessionTimers,
    eventMatchesSession,
    clearSnapshotIfSame,
    canMutateSessionRestoreState,
    finishSessionRestore,
    isLatestInitRequest
  };

  root.YtPositionSaverShared = api;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
