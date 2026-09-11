'use strict';

const { it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function eventTarget() {
  const listeners = new Map();
  return {
    addEventListener(type, fn, options) {
      if (!listeners.has(type)) listeners.set(type, new Map());
      listeners.get(type).set(fn, options);
    },
    removeEventListener(type, fn) { listeners.get(type)?.delete(fn); },
    emit(type) {
      for (const [fn, options] of [...(listeners.get(type) || [])]) {
        if (options?.once) listeners.get(type).delete(fn);
        fn({ type, currentTarget: this });
      }
    }
  };
}

async function harness({ stored, ad = false, holdRead = false, readyState = 1, settings = {} } = {}) {
  const timers = new Map();
  let nextTimer = 0;
  const setTimer = (fn, delay, repeat = false) => {
    timers.set(++nextTimer, { fn, delay, repeat });
    return nextTimer;
  };
  const window = Object.assign(eventTarget(), { location: { search: '?v=AAAAAAAAAAA' } });
  const player = { classList: { contains: () => ad } };
  const video = Object.assign(eventTarget(), {
    currentTime: 0, duration: 600, readyState, paused: false,
    closest: () => player,
    pause() { this.paused = true; this.emit('pause'); },
    play() { this.paused = false; return Promise.resolve(); }
  });
  const document = Object.assign(eventTarget(), {
    title: 'Video A', hidden: false,
    querySelector: (selector) => selector === 'video.html5-main-video' ? video :
      selector === '.html5-video-player' ? player : null
  });
  const data = stored ? { yt_position_AAAAAAAAAAA: { ...stored } } : {};
  const writes = [];
  const removals = [];
  const reads = [];
  let settingsListener;
  const chrome = {
    runtime: { id: 'test', onMessage: { addListener() {}, removeListener() {} } },
    storage: {
      onChanged: { addListener(fn) { settingsListener = fn; }, removeListener() {} },
      local: {
        async get(key) {
          if (key === 'yt_position_settings') {
            return { [key]: { enabled: true, notifyOnRestore: false, ...settings } };
          }
          if (holdRead) await new Promise(resolve => reads.push(resolve));
          return { [key]: data[key] && { ...data[key] } };
        },
        async set(values) { writes.push(structuredClone(values)); Object.assign(data, values); },
        async remove(key) { removals.push(key); delete data[key]; }
      }
    }
  };
  const context = vm.createContext({
    window, document, chrome, URLSearchParams,
    console: { log() {}, warn() {}, error() {} },
    setTimeout: (fn, delay) => setTimer(fn, delay),
    clearTimeout: id => timers.delete(id),
    setInterval: (fn, delay) => setTimer(fn, delay, true),
    clearInterval: id => timers.delete(id)
  });
  for (const name of ['shared.js', 'content.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', name), 'utf8'), context, { filename: name });
  }
  async function flush() { for (let i = 0; i < 30; i++) await Promise.resolve(); }
  async function runTimer(delay) {
    const entry = [...timers].find(([, timer]) => timer.delay === delay);
    assert.ok(entry, `expected timer with delay ${delay}`);
    const [id, timer] = entry;
    if (!timer.repeat) timers.delete(id);
    timer.fn();
    await flush();
  }
  await runTimer(0);
  return {
    window, document, video, data, writes, removals, flush, runTimer,
    setAd(value) { ad = value; },
    async releaseReads() { holdRead = false; reads.splice(0).forEach(resolve => resolve()); await flush(); },
    disable() { settingsListener({ yt_position_settings: { newValue: { enabled: false } } }, 'local'); },
    hide() { document.hidden = true; document.emit('visibilitychange'); }
  };
}

for (const { minSaveSeconds, duration, shouldSave } of [
  { minSaveSeconds: 10, duration: 5, shouldSave: false },
  { minSaveSeconds: 10, duration: 10, shouldSave: true },
  { minSaveSeconds: 0, duration: 5, shouldSave: true }
]) {
  it(`completed video of ${duration}s respects minimum ${minSaveSeconds}s when retained`, async () => {
    const h = await harness({ settings: { minSaveSeconds, autoDeleteWatched: false } });
    h.video.duration = duration;
    h.video.currentTime = duration;
    h.video.emit('ended');
    await h.flush();
    h.hide();
    await h.flush();

    if (shouldSave) {
      assert.equal(h.data.yt_position_AAAAAAAAAAA.position, duration);
    } else {
      assert.equal(h.writes.length, 0);
      assert.equal(h.data.yt_position_AAAAAAAAAAA, undefined);
    }
    assert.deepEqual(h.removals, []);
  });
}

it('completed video is still deleted below the minimum when automatic deletion is enabled', async () => {
  const h = await harness({ settings: { minSaveSeconds: 10, autoDeleteWatched: true } });
  h.data.yt_position_AAAAAAAAAAA = { position: 2, duration: 5, timestamp: Date.now(), title: 'Video A' };
  h.video.duration = 5;
  h.video.currentTime = 5;
  h.video.emit('ended');
  await h.flush();

  assert.equal(h.writes.length, 0);
  assert.equal(h.data.yt_position_AAAAAAAAAAA, undefined);
  assert.deepEqual(h.removals, ['yt_position_AAAAAAAAAAA']);
});

it('real content events freeze A before the same video element becomes B', async () => {
  const h = await harness();
  h.video.currentTime = 120;
  h.video.emit('timeupdate');
  h.window.emit('yt-navigate-start');
  // YouTube can reuse the media element before updating the URL.
  h.video.currentTime = 0;
  h.video.duration = 900;
  h.video.emit('timeupdate');
  h.video.emit('pause');
  h.video.emit('ended');
  h.window.location.search = '?v=BBBBBBBBBBB';
  h.window.emit('yt-navigate-finish');
  await h.flush();
  assert.equal(h.data.yt_position_AAAAAAAAAAA.position, 120);
  assert.equal(h.data.yt_position_AAAAAAAAAAA.duration, 600);
  assert.deepEqual(h.removals, []);
  await h.runTimer(0);
  h.video.currentTime = 45;
  h.video.emit('timeupdate');
  h.hide();
  await h.flush();
  assert.equal(h.data.yt_position_BBBBBBBBBBB.position, 45);
});

it('URL ownership rejects reused media even without navigate-start', async () => {
  const h = await harness();
  h.video.currentTime = 120;
  h.video.emit('timeupdate');
  h.window.location.search = '?v=BBBBBBBBBBB';
  h.video.currentTime = 0;
  h.video.duration = 900;
  h.video.emit('timeupdate');
  h.video.emit('pause');
  h.hide();
  await h.flush();
  assert.equal(h.data.yt_position_AAAAAAAAAAA.position, 120);
  assert.equal(h.data.yt_position_AAAAAAAAAAA.duration, 600);
});

for (const event of ['visibilitychange', 'yt-navigate-start', 'beforeunload']) {
  it(`pending storage read blocks zero snapshots on ${event}`, async () => {
    const h = await harness({ stored: { position: 300, duration: 600 }, holdRead: true });
    h.video.emit('timeupdate');
    h.video.emit('pause');
    h.video.emit('ended');
    if (event === 'visibilitychange') h.hide();
    else h.window.emit(event);
    await h.flush();
    assert.equal(h.data.yt_position_AAAAAAAAAAA.position, 300);
    assert.deepEqual(h.writes, []);
    assert.deepEqual(h.removals, []);
    await h.releaseReads();
    if (event === 'yt-navigate-start') assert.equal(h.video.currentTime, 0);
  });
}

it('seek completion unlocks saving only after restoration', async () => {
  const h = await harness({ stored: { position: 300, duration: 600 } });
  assert.equal(h.video.currentTime, 300);
  h.video.emit('timeupdate');
  h.hide();
  await h.flush();
  assert.deepEqual(h.writes, []);
  h.video.emit('seeked');
  await h.flush();
  h.video.currentTime = 310;
  h.video.emit('timeupdate');
  h.hide();
  await h.flush();
  assert.equal(h.data.yt_position_AAAAAAAAAAA.position, 310);
});

it('ad end remains save-blocked until the retry restores the saved position', async () => {
  const h = await harness({ stored: { position: 300, duration: 600 }, ad: true });
  h.setAd(false);
  h.video.emit('timeupdate');
  h.video.emit('pause');
  h.hide();
  await h.runTimer(5000);
  assert.equal(h.data.yt_position_AAAAAAAAAAA.position, 300);
  assert.deepEqual(h.writes, []);
  await h.runTimer(1000);
  assert.equal(h.video.currentTime, 300);
  h.video.emit('seeked');
  await h.flush();
  h.video.currentTime = 320;
  h.video.emit('pause');
  await h.flush();
  assert.equal(h.data.yt_position_AAAAAAAAAAA.position, 320);
});

it('disabling discards a snapshot before navigation or hiding', async () => {
  const h = await harness();
  h.video.currentTime = 120;
  h.video.emit('timeupdate');
  h.disable();
  h.hide();
  h.window.emit('beforeunload');
  h.window.emit('yt-navigate-start');
  await h.flush();
  assert.deepEqual(h.writes, []);
});

it('metadata wait protects the saved position', async () => {
  const h = await harness({ stored: { position: 300, duration: 600 }, readyState: 0 });
  h.video.emit('timeupdate');
  h.hide();
  await h.flush();
  assert.deepEqual(h.writes, []);
  h.video.readyState = 1;
  h.video.emit('loadedmetadata');
  await h.flush();
  assert.equal(h.video.currentTime, 300);
});

it('old seek completion cannot resume a reused video after navigation starts', async () => {
  const h = await harness({ stored: { position: 300, duration: 600 } });
  h.window.emit('yt-navigate-start');
  h.video.currentTime = 0;
  h.video.emit('seeked');
  await h.flush();
  assert.equal(h.video.paused, true);
  assert.equal(h.video.currentTime, 0);
  assert.deepEqual(h.writes, []);
});

it('popstate immediately after navigate-finish still initializes the new video', async () => {
  const h = await harness();
  h.window.location.search = '?v=BBBBBBBBBBB';
  h.window.emit('yt-navigate-finish');
  h.window.emit('popstate');
  await h.runTimer(300);
  h.video.currentTime = 40;
  h.video.emit('pause');
  await h.flush();
  assert.equal(h.data.yt_position_BBBBBBBBBBB.position, 40);
});
