'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const Shared = require('../shared.js');

describe('normalizeSettings', () => {
  it('returns defaults for empty input', () => {
    assert.deepEqual(Shared.normalizeSettings(null), Shared.DEFAULT_SETTINGS);
    assert.deepEqual(Shared.normalizeSettings(undefined), Shared.DEFAULT_SETTINGS);
  });

  it('keeps allowed values and drops unknown fields', () => {
    const normalized = Shared.normalizeSettings({
      enabled: false,
      notifyOnRestore: false,
      autoPlayOnRestore: false,
      minSaveSeconds: 30,
      autoDeleteWatched: false,
      saveIntervalSeconds: 10,
      autoCleanupDays: 90,
      openVideoMode: 'new',
      evil: true,
      nested: { x: 1 }
    });

    assert.deepEqual(normalized, {
      enabled: false,
      notifyOnRestore: false,
      autoPlayOnRestore: false,
      minSaveSeconds: 30,
      autoDeleteWatched: false,
      saveIntervalSeconds: 10,
      autoCleanupDays: 90,
      openVideoMode: 'new'
    });
    assert.equal('evil' in normalized, false);
  });

  it('falls back for negative or tiny save intervals', () => {
    assert.equal(Shared.normalizeSettings({ saveIntervalSeconds: -1 }).saveIntervalSeconds, 5);
    assert.equal(Shared.normalizeSettings({ saveIntervalSeconds: 0.001 }).saveIntervalSeconds, 5);
    assert.equal(Shared.normalizeSettings({ saveIntervalSeconds: 1 }).saveIntervalSeconds, 5);
    assert.equal(Shared.getSaveIntervalMs({ saveIntervalSeconds: -1 }), 5000);
    assert.equal(Shared.getSaveIntervalMs({ saveIntervalSeconds: 30 }), 30000);
  });

  it('falls back for invalid enums and non-booleans', () => {
    const normalized = Shared.normalizeSettings({
      enabled: 'yes',
      minSaveSeconds: 15,
      openVideoMode: 'tab',
      autoCleanupDays: 7
    });
    assert.equal(normalized.enabled, true);
    assert.equal(normalized.minSaveSeconds, 0);
    assert.equal(normalized.openVideoMode, 'existing');
    assert.equal(normalized.autoCleanupDays, 0);
  });
});

describe('validateVideoRecord / normalizeVideoRecord', () => {
  const valid = {
    videoId: 'dQw4w9WgXcQ',
    position: 12.5,
    duration: 100,
    timestamp: Date.now(),
    title: 'Sample - YouTube'
  };

  it('accepts a valid record', () => {
    assert.equal(Shared.validateVideoRecord(valid), true);
    assert.deepEqual(Shared.normalizeVideoRecord(valid), valid);
  });

  it('rejects invalid videoId and non-finite numbers', () => {
    assert.equal(Shared.validateVideoRecord({ ...valid, videoId: 'short' }), false);
    assert.equal(Shared.validateVideoRecord({ ...valid, position: NaN }), false);
    assert.equal(Shared.validateVideoRecord({ ...valid, duration: -1 }), false);
    assert.equal(Shared.validateVideoRecord({ ...valid, position: 200, duration: 100 }), false);
  });

  it('rejects object titles and normalizes string titles', () => {
    assert.equal(Shared.validateVideoRecord({ ...valid, title: { evil: true } }), false);
    const normalized = Shared.normalizeVideoRecord({ ...valid, title: '  ok  ' });
    assert.equal(normalized.title, 'ok');
  });
});

describe('parseImportPayload', () => {
  it('parses version 1 payload with settings and videos', () => {
    const payload = {
      version: 1,
      settings: { enabled: false, saveIntervalSeconds: -1 },
      videos: [
        {
          videoId: 'dQw4w9WgXcQ',
          position: 10,
          duration: 100,
          timestamp: 1,
          title: 'A'
        },
        {
          videoId: 'bad',
          position: 1,
          duration: 2,
          timestamp: 1
        }
      ]
    };

    const parsed = Shared.parseImportPayload(JSON.stringify(payload));
    assert.equal(parsed.version, 1);
    assert.equal(parsed.settings.enabled, false);
    assert.equal(parsed.settings.saveIntervalSeconds, 5);
    assert.equal(parsed.videos.length, 1);
    assert.equal(parsed.videos[0].videoId, 'dQw4w9WgXcQ');
  });

  it('rejects unsupported or missing useful data', () => {
    assert.throws(
      () => Shared.parseImportPayload(JSON.stringify({ version: 2, videos: [] })),
      /Unsupported import version/
    );
    assert.throws(
      () => Shared.parseImportPayload(JSON.stringify({ version: 1, videos: [] })),
      /Invalid import file/
    );
  });

  it('rejects oversized files and too many records', () => {
    assert.throws(
      () => Shared.parseImportPayload('{}', Shared.MAX_IMPORT_BYTES + 1),
      /Import file too large/
    );

    const videos = Array.from({ length: Shared.MAX_IMPORT_RECORDS + 1 }, (_, i) => ({
      videoId: 'dQw4w9WgXcQ',
      position: 1,
      duration: 2,
      timestamp: i,
      title: 'x'
    }));
    assert.throws(
      () => Shared.parseImportPayload(JSON.stringify({ version: 1, videos })),
      /Too many import records/
    );
  });
});

describe('session helpers', () => {
  it('tracks generation and clears only owned timers', () => {
    const sessionA = Shared.createVideoSession(1, 'aaaaaaaaaaa');
    const sessionB = Shared.createVideoSession(2, 'bbbbbbbbbbb');

    let aCleared = false;
    let bCleared = false;

    sessionA.checkIntervalId = setInterval(() => {}, 1000);
    sessionA.checkTimeoutId = setTimeout(() => {}, 5000);
    sessionB.checkIntervalId = setInterval(() => {}, 1000);

    const originalClearInterval = global.clearInterval;
    const originalClearTimeout = global.clearTimeout;

    global.clearInterval = (id) => {
      if (id === sessionA.checkIntervalId) aCleared = true;
      if (id === sessionB.checkIntervalId) bCleared = true;
      return originalClearInterval(id);
    };
    global.clearTimeout = (id) => originalClearTimeout(id);

    try {
      Shared.clearSessionTimers(sessionA);
      assert.equal(aCleared, true);
      assert.equal(bCleared, false);
      assert.equal(sessionA.checkIntervalId, null);
      assert.equal(sessionA.checkTimeoutId, null);
      assert.notEqual(sessionB.checkIntervalId, null);

      assert.equal(Shared.isCurrentSession(sessionA, 1), true);
      assert.equal(Shared.isCurrentSession(sessionA, 2), false);

      const videoRef = { id: 'video' };
      sessionA.videoRef = videoRef;
      assert.equal(Shared.isCurrentSession(sessionA, 1, videoRef), true);
      assert.equal(Shared.isCurrentSession(sessionA, 1, { id: 'other' }), false);
      assert.equal(sessionA.isRestoring, false);
      assert.equal(sessionA.pausedForPendingRestore, false);
    } finally {
      global.clearInterval = originalClearInterval;
      global.clearTimeout = originalClearTimeout;
      if (sessionB.checkIntervalId) clearInterval(sessionB.checkIntervalId);
    }
  });

  it('does not let an old timeout clear a newer session interval', () => {
    const oldSession = Shared.createVideoSession(1, 'oldVideoId1');
    const newSession = Shared.createVideoSession(2, 'newVideoId2');

    oldSession.checkIntervalId = setInterval(() => {}, 1000);
    newSession.checkIntervalId = setInterval(() => {}, 1000);

    const oldIntervalId = oldSession.checkIntervalId;
    const newIntervalId = newSession.checkIntervalId;

    // 旧セッション破棄後、新セッションの interval は残る
    Shared.clearSessionTimers(oldSession);
    assert.equal(oldSession.checkIntervalId, null);
    assert.equal(newSession.checkIntervalId, newIntervalId);
    assert.notEqual(newIntervalId, oldIntervalId);

    clearInterval(newSession.checkIntervalId);
  });
});
