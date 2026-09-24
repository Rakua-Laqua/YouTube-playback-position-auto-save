'use strict';

// background.js の診断ログ記録を Chrome API のモック上で検証する。
// 記録対象の絞り込み（YouTube の URL 変化・読み込み開始・破棄だけ）と、並行イベントで記録が消えないことを確認する。

const { it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function event() {
  const fns = [];
  return { addListener: (fn) => fns.push(fn), fire: (...args) => fns.forEach((fn) => fn(...args)) };
}

function loadBackground({ tabs = [] } = {}) {
  const store = {};
  const chrome = {
    storage: {
      local: {
        // 実際の storage と同じく非同期にして、書き込みの直列化を検証できるようにする
        get: async (key) => {
          await new Promise((r) => setImmediate(r));
          return key in store ? { [key]: structuredClone(store[key]) } : {};
        },
        set: async (obj) => {
          await new Promise((r) => setImmediate(r));
          Object.assign(store, structuredClone(obj));
        }
      }
    },
    tabs: {
      onCreated: event(),
      onUpdated: event(),
      query: async () => tabs,
      get: async () => ({}),
      sendMessage: () => {}
    },
    scripting: { executeScript: async () => {} },
    runtime: { onInstalled: event(), onStartup: event(), lastError: null }
  };
  const root = path.join(__dirname, '..');
  const context = vm.createContext({ chrome, console: { log() {}, warn() {} }, setTimeout, clearTimeout, URL });
  context.globalThis = context;
  context.importScripts = (file) => vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), context);
  vm.runInContext(fs.readFileSync(path.join(root, 'background.js'), 'utf8'), context);
  const flush = () => vm.runInContext('diagWriteChain', context);
  return { chrome, store, flush };
}

it('records YouTube URL changes and ignores other updates', async () => {
  const { chrome, store, flush } = loadBackground();
  const yt = 'https://www.youtube.com/watch?v=abcdefghijk&list=PLx&index=6';
  chrome.tabs.onUpdated.fire(1, { url: yt }, { url: yt });
  chrome.tabs.onUpdated.fire(1, { title: 'x' }, { url: yt });
  chrome.tabs.onUpdated.fire(1, { audible: true }, { url: yt });
  chrome.tabs.onUpdated.fire(2, { url: 'https://example.com/' }, { url: 'https://example.com/' });
  chrome.tabs.onUpdated.fire(1, { status: 'loading' }, { url: yt });
  chrome.tabs.onUpdated.fire(1, { discarded: true }, { url: yt });
  await flush();

  const log = store.diag_nav_log;
  assert.equal(log.length, 3);
  assert.deepEqual(log.map((e) => [e.urlChanged, e.status, e.discarded]), [
    [true, undefined, undefined],
    [false, 'loading', undefined],
    [false, undefined, true]
  ]);
  assert.equal(log[0].parsed.index, '6');
  assert.equal(log[0].tabId, 1);
});

it('keeps every entry when events arrive concurrently', async () => {
  const { chrome, store, flush } = loadBackground();
  for (let i = 1; i <= 20; i++) {
    const url = `https://www.youtube.com/watch?v=abcdefghijk&list=PLx&index=${i}`;
    chrome.tabs.onUpdated.fire(1, { url }, { url });
  }
  await flush();
  assert.deepEqual(store.diag_nav_log.map((e) => e.parsed.index), Array.from({ length: 20 }, (_, i) => String(i + 1)));
});

it('snapshots restored YouTube tabs at browser startup, including pending URLs', async () => {
  const { chrome, store, flush } = loadBackground({
    tabs: [
      { id: 5, windowId: 1, url: '', pendingUrl: 'https://www.youtube.com/watch?v=abcdefghijk&list=PLx&index=1', status: 'unloaded' },
      { id: 6, windowId: 1, url: 'https://example.com/', status: 'complete' }
    ]
  });
  chrome.runtime.onStartup.fire();
  await new Promise((r) => setImmediate(r));
  await flush();

  const [entry] = store.diag_nav_log;
  assert.equal(entry.event, 'browser-startup');
  assert.equal(entry.tabs.length, 1);
  assert.equal(entry.tabs[0].tabId, 5);
  assert.equal(entry.tabs[0].parsed.index, '1');
});
