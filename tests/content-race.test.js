'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const Shared = require('../shared.js');

function createFakeVideo(initial = {}) {
  const listeners = new Map();
  const video = {
    currentTime: initial.currentTime ?? 0,
    duration: initial.duration ?? 100,
    paused: initial.paused ?? false,
    readyState: initial.readyState ?? 1,
    addEventListener(type, handler) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(handler);
    },
    removeEventListener(type, handler) {
      listeners.get(type)?.delete(handler);
    },
    pause() {
      this.paused = true;
    },
    play() {
      this.paused = false;
      return Promise.resolve();
    },
    emit(type) {
      for (const handler of listeners.get(type) || []) {
        handler({ currentTarget: video, type });
      }
    }
  };
  return video;
}

describe('session media ownership', () => {
  it('rejects events from old video after session switch', () => {
    const oldVideo = createFakeVideo({ currentTime: 40 });
    const newVideo = createFakeVideo({ currentTime: 1 });
    const oldSession = Shared.createVideoSession(1, 'oldVideoId01');
    oldSession.videoRef = oldVideo;

    const newSession = Shared.createVideoSession(2, 'newVideoId02');
    newSession.videoRef = newVideo;

    assert.equal(Shared.eventMatchesSession(oldSession, oldVideo), true);
    assert.equal(Shared.eventMatchesSession(newSession, oldVideo), false);
    assert.equal(Shared.eventMatchesSession(newSession, newVideo), true);
  });

  it('does not mix new videoId with old videoRef for save eligibility', () => {
    const oldVideo = createFakeVideo({ currentTime: 55 });
    const session = Shared.createVideoSession(2, 'newVideoId02');
    session.videoRef = null;

    // beginSession 後: videoRef 未設定のまま旧videoイベントが来ても所有とみなさない
    assert.equal(Shared.eventMatchesSession(session, oldVideo), false);

    session.videoRef = createFakeVideo({ currentTime: 2 });
    assert.equal(Shared.eventMatchesSession(session, oldVideo), false);
  });
});

describe('restore state isolation', () => {
  it('old finishRestore does not clear new session restoring flags', () => {
    const oldVideo = createFakeVideo();
    const newVideo = createFakeVideo();
    const oldSession = Shared.createVideoSession(1, 'oldVideoId01');
    oldSession.videoRef = oldVideo;
    oldSession.isRestoring = true;
    oldSession.pausedForPendingRestore = true;

    const newSession = Shared.createVideoSession(2, 'newVideoId02');
    newSession.videoRef = newVideo;
    newSession.isRestoring = true;
    newSession.pausedForPendingRestore = true;

    const result = Shared.finishSessionRestore(oldSession, newSession, { resumeIfPaused: true });
    assert.equal(result.applied, false);
    assert.equal(newSession.isRestoring, true);
    assert.equal(newSession.pausedForPendingRestore, true);
    assert.equal(oldSession.isRestoring, true);
  });

  it('active session finishRestore clears only that session', () => {
    const video = createFakeVideo({ paused: true });
    const session = Shared.createVideoSession(3, 'vid12345678');
    session.videoRef = video;
    session.isRestoring = true;
    session.pausedForPendingRestore = true;

    const result = Shared.finishSessionRestore(session, session, { resumeIfPaused: true });
    assert.equal(result.applied, true);
    assert.equal(result.shouldResume, true);
    assert.equal(session.isRestoring, false);
    assert.equal(session.pausedForPendingRestore, false);
  });

  it('generation change mid-restore leaves new session untouched', async () => {
    const oldVideo = createFakeVideo({ duration: 100, currentTime: 0 });
    const oldSession = Shared.createVideoSession(1, 'oldVideoId01');
    oldSession.videoRef = oldVideo;
    oldSession.isRestoring = true;
    oldSession.pausedForPendingRestore = true;

    let activeSession = oldSession;
    const storageGet = () => new Promise((resolve) => {
      // await 中に世代が進む状況を再現
      const newSession = Shared.createVideoSession(2, 'newVideoId02');
      newSession.videoRef = createFakeVideo();
      newSession.isRestoring = true;
      newSession.pausedForPendingRestore = true;
      activeSession = newSession;
      resolve({ yt_position_oldVideoId01: { position: 30, duration: 100 } });
    });

    await storageGet();
    assert.equal(Shared.canMutateSessionRestoreState(oldSession, activeSession), false);

    const staleFinish = Shared.finishSessionRestore(oldSession, activeSession, { resumeIfPaused: true });
    assert.equal(staleFinish.applied, false);
    assert.equal(activeSession.isRestoring, true);
    assert.equal(activeSession.pausedForPendingRestore, true);
  });
});

describe('concurrent navigation snapshots', () => {
  it('old saveForNavigation finally does not clear a newer snapshot', async () => {
    let lastValidPosition = {
      videoId: 'oldVideoId01',
      data: { position: 20, duration: 100, timestamp: 1, title: 'old' }
    };

    const writes = [];
    async function saveForNavigation() {
      const snapshot = lastValidPosition;
      try {
        await new Promise((resolve) => setTimeout(resolve, 5));
        if (snapshot) {
          writes.push(snapshot.videoId);
        }
      } finally {
        lastValidPosition = Shared.clearSnapshotIfSame(lastValidPosition, snapshot);
      }
    }

    const first = saveForNavigation();
    // 旧保存の await 中に新動画のスナップショットへ更新
    lastValidPosition = {
      videoId: 'newVideoId02',
      data: { position: 3, duration: 200, timestamp: 2, title: 'new' }
    };
    const second = saveForNavigation();
    await Promise.all([first, second]);

    assert.deepEqual(writes, ['oldVideoId01', 'newVideoId02']);
    assert.equal(lastValidPosition, null);
  });

  it('clearSnapshotIfSame keeps newer object', () => {
    const older = { videoId: 'a', data: { position: 1 } };
    const newer = { videoId: 'b', data: { position: 2 } };
    assert.equal(Shared.clearSnapshotIfSame(newer, older), newer);
    assert.equal(Shared.clearSnapshotIfSame(older, older), null);
  });
});

describe('ended delete rejection policy', () => {
  it('keeps hasEnded and cleared snapshot even when remove rejects', async () => {
    let hasEnded = false;
    let lastValidPosition = { videoId: 'vid12345678', data: { position: 90 } };
    const remove = async () => {
      throw new Error('quota');
    };

    hasEnded = true;
    lastValidPosition = null;
    let removeFailed = false;
    try {
      await remove();
    } catch (e) {
      removeFailed = true;
    }

    assert.equal(removeFailed, true);
    assert.equal(hasEnded, true);
    assert.equal(lastValidPosition, null);
  });
});

describe('settings disabled cancels restore mutation', () => {
  it('discarded session cannot finish restore on the next active session', () => {
    const restoring = Shared.createVideoSession(4, 'vid12345678');
    restoring.isRestoring = true;
    restoring.pausedForPendingRestore = true;

    // 設定無効化で discard された後の新セッション
    const discardedReplacement = Shared.createVideoSession(5, null);

    const result = Shared.finishSessionRestore(restoring, discardedReplacement, {
      resumeIfPaused: true
    });
    assert.equal(result.applied, false);
    assert.equal(discardedReplacement.isRestoring, false);
    assert.equal(restoring.isRestoring, true);
  });
});

describe('concurrent init request ordering', () => {
  it('stale init does not beginSession after a newer init completes', async () => {
    let latestRequestId = 0;
    const began = [];

    async function runInit(requestId, videoId, delayMs) {
      // isEnabled / saveForNavigation 相当の待機
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      if (!Shared.isLatestInitRequest(requestId, latestRequestId)) return;
      began.push(videoId);
    }

    const olderId = ++latestRequestId; // 1
    const newerId = ++latestRequestId; // 2

    // 旧 init を遅く完了させ、新 init が先に beginSession する状況を再現
    const older = runInit(olderId, 'oldVideoId01', 30);
    const newer = runInit(newerId, 'newVideoId02', 5);
    await Promise.all([older, newer]);

    assert.deepEqual(began, ['newVideoId02']);
    assert.equal(Shared.isLatestInitRequest(olderId, latestRequestId), false);
    assert.equal(Shared.isLatestInitRequest(newerId, latestRequestId), true);
  });

  it('cleanup increments request id and invalidates in-flight init', async () => {
    let latestRequestId = 1;
    let began = false;

    const inFlight = (async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      if (!Shared.isLatestInitRequest(1, latestRequestId)) return;
      began = true;
    })();

    // cleanupContentScript / invalidateInitRequests 相当
    latestRequestId += 1;
    await inFlight;

    assert.equal(began, false);
  });

  it('disabling settings invalidates in-flight init after isEnabled passed', async () => {
    let latestRequestId = 0;
    let pendingTimerId = null;
    const began = [];

    function invalidateInitRequests() {
      latestRequestId += 1;
      if (pendingTimerId) {
        clearTimeout(pendingTimerId);
        pendingTimerId = null;
      }
    }

    function scheduleInit(videoId, delayMs) {
      const requestId = ++latestRequestId;
      if (pendingTimerId) {
        clearTimeout(pendingTimerId);
      }
      pendingTimerId = setTimeout(() => {
        pendingTimerId = null;
        void runInit(requestId, videoId);
      }, delayMs);
    }

    async function runInit(requestId, videoId) {
      // isEnabled() を有効で通過済みのあと、saveForNavigation() 待ちを再現
      await new Promise((resolve) => setTimeout(resolve, 20));
      if (!Shared.isLatestInitRequest(requestId, latestRequestId)) return;
      began.push(videoId);
    }

    scheduleInit('vidAfterEnable', 0);
    // saveForNavigation 待ち中にユーザーが無効化
    await new Promise((resolve) => setTimeout(resolve, 5));
    invalidateInitRequests();
    await new Promise((resolve) => setTimeout(resolve, 30));

    assert.deepEqual(began, []);
    assert.equal(pendingTimerId, null);
  });
});
