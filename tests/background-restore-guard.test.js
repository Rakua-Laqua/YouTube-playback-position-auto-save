'use strict';

// background.js の再起動後復元先すり替え補正を Chrome API モック上で検証する。

const { it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const NAV_EVENTS = ['onBeforeNavigate', 'onErrorOccurred', 'onCommitted'];
// 10/13 に観測した並び: 復元タブ作成（#4, unloaded）→ #4 の読み込み開始 → ERR_ABORTED → 1ms 後に #2 の読み込み開始 → #2 確定
const RESTORED = 'https://www.youtube.com/watch?v=TSsKzpLjGZQ&list=PLej&index=4';
const SWAPPED = 'https://www.youtube.com/watch?v=YxsVe_nbfzc&list=PLej&index=2';

function event() {
  const registrations = [];
  // API 側フィルターを通さず fire し、コールバック側の絞り込みも検証する。
  return {
    registrations,
    addListener: (fn, filter) => registrations.push({ fn, filter }),
    fire: (...args) => registrations.forEach(({ fn }) => fn(...args))
  };
}

function loadBackground({ tabs = [], store = {}, sessionStore = {}, withWebNavigation = true } = {}) {
  const updatedTabs = [];
  const chrome = {
    storage: {
      local: {
        get: async (key) => {
          await new Promise((r) => setImmediate(r));
          return key in store ? { [key]: structuredClone(store[key]) } : {};
        },
        set: async (obj) => {
          await new Promise((r) => setImmediate(r));
          Object.assign(store, structuredClone(obj));
        }
      },
      // 復元補正の監視状態。Worker 再起動をまたぐ検証のため、呼び出し側から同じ入れ物を渡せるようにする
      session: {
        get: async (key) => (key in sessionStore ? { [key]: structuredClone(sessionStore[key]) } : {}),
        set: async (obj) => { Object.assign(sessionStore, structuredClone(obj)); }
      }
    },
    tabs: {
      onCreated: event(),
      onRemoved: event(),
      // vm 内で作られたオブジェクトは別 realm なので、比較できる形に写す
      update: async (tabId, props) => { updatedTabs.push(JSON.parse(JSON.stringify([tabId, props]))); return {}; },
      query: async () => tabs,
      get: async () => ({}),
      sendMessage: () => {}
    },
    scripting: { executeScript: async () => {} },
    runtime: {
      onInstalled: event(),
      onStartup: event(),
      lastError: null
    }
  };
  if (withWebNavigation) chrome.webNavigation = Object.fromEntries(NAV_EVENTS.map((name) => [name, event()]));
  const root = path.join(__dirname, '..');
  const context = vm.createContext({
    chrome, console: { log() {}, warn() {} }, setTimeout, clearTimeout, URL
  });
  context.globalThis = context;
  context.importScripts = (file) => vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), context);
  vm.runInContext(fs.readFileSync(path.join(root, 'background.js'), 'utf8'), context);
  const flush = async () => {
    await vm.runInContext('restoreGuardChain', context);
  };
  return { chrome, store, sessionStore, updatedTabs, flush };
}

function nav(chrome, kind, tabId, url, timeStamp, extra = {}) {
  chrome.webNavigation[kind].fire({ tabId, frameId: 0, url, timeStamp, ...extra });
}

function fireSwap(chrome, { tabId = 7, status = 'unloaded', gapMs = 1 } = {}) {
  chrome.tabs.onCreated.fire({ id: tabId, url: RESTORED, status });
  nav(chrome, 'onBeforeNavigate', tabId, RESTORED, 1000);
  nav(chrome, 'onErrorOccurred', tabId, RESTORED, 1030, { error: 'net::ERR_ABORTED' });
  nav(chrome, 'onBeforeNavigate', tabId, SWAPPED, 1030 + gapMs);
  nav(chrome, 'onCommitted', tabId, SWAPPED, 1300, { transitionType: 'link', transitionQualifiers: [] });
}

it('returns a restored tab to the URL Chrome restored when the load is swapped', async () => {
  const { chrome, updatedTabs, flush } = loadBackground();
  fireSwap(chrome);
  await flush();
  await flush();
  assert.deepEqual(updatedTabs, [[7, { url: RESTORED }]]);
});

it('leaves a correctly restored tab alone and stops watching it', async () => {
  const { chrome, sessionStore, updatedTabs, flush } = loadBackground();
  chrome.tabs.onCreated.fire({ id: 7, url: RESTORED, status: 'unloaded' });
  nav(chrome, 'onBeforeNavigate', 7, RESTORED, 1000);
  nav(chrome, 'onCommitted', 7, RESTORED, 1300);
  await flush();
  assert.deepEqual(updatedTabs, []);
  assert.deepEqual(sessionStore.restoreGuardTabs, {});
});

it('does not redirect tabs that were not restored, slow re-navigations, or a disabled extension', async () => {
  for (const [options, store] of [
    [{ status: 'loading' }, {}],
    [{ gapMs: 5000 }, {}],
    [{}, { yt_position_settings: { enabled: false } }]
  ]) {
    const { chrome, updatedTabs, flush } = loadBackground({ store });
    fireSwap(chrome, options);
    await flush();
    await flush();
    assert.deepEqual(updatedTabs, [], JSON.stringify(options));
  }
});

it('drops the guard when the user navigates before the swap pattern completes', async () => {
  const { chrome, updatedTabs, flush } = loadBackground();
  chrome.tabs.onCreated.fire({ id: 7, url: RESTORED, status: 'unloaded' });
  nav(chrome, 'onBeforeNavigate', 7, SWAPPED, 1000);
  nav(chrome, 'onCommitted', 7, SWAPPED, 1300);
  await flush();
  assert.deepEqual(updatedTabs, []);
});

it('keeps watching a lazily restored tab across a service worker restart', async () => {
  const sessionStore = {};
  const first = loadBackground({ sessionStore });
  first.chrome.tabs.onCreated.fire({ id: 7, url: RESTORED, status: 'unloaded' });
  await first.flush();

  // 背面タブが選択されて読み込まれる頃には、Worker が作り直されている
  const second = loadBackground({ sessionStore });
  nav(second.chrome, 'onBeforeNavigate', 7, RESTORED, 1000);
  nav(second.chrome, 'onErrorOccurred', 7, RESTORED, 1030, { error: 'net::ERR_ABORTED' });
  nav(second.chrome, 'onBeforeNavigate', 7, SWAPPED, 1031);
  nav(second.chrome, 'onCommitted', 7, SWAPPED, 1300);
  await second.flush();
  await second.flush();
  assert.deepEqual(second.updatedTabs, [[7, { url: RESTORED }]]);
});

it('forgets the guard when the tab is closed', async () => {
  const { chrome, sessionStore, flush } = loadBackground();
  chrome.tabs.onCreated.fire({ id: 7, url: RESTORED, status: 'unloaded' });
  chrome.tabs.onRemoved.fire(7, { isWindowClosing: false });
  await flush();
  assert.deepEqual(sessionStore.restoreGuardTabs, {});
});
