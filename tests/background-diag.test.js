'use strict';

// background.js の診断ログ記録を Chrome API のモック上で検証する。
// 復元時の URL の取り違え、主フレーム以外の混入、並行書き込み・Worker 再起動による誤読を防ぐ。

const { it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { randomUUID } = require('node:crypto');

const NAV_EVENTS = [
  'onBeforeNavigate', 'onCommitted', 'onDOMContentLoaded', 'onHistoryStateUpdated',
  'onReferenceFragmentUpdated', 'onCompleted', 'onErrorOccurred'
];
const FIRST = 'https://www.youtube.com/watch?v=D4_aoCd7hwQ&list=PLx';
const SECOND = 'https://www.youtube.com/watch?v=BXe7BA51a2U&list=PLx&index=2';

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
  let failWrites = 0;
  const updatedTabs = [];
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
          if (failWrites > 0) {
            failWrites--;
            throw new Error('simulated storage failure');
          }
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
      onUpdated: event(),
      onRemoved: event(),
      // vm 内で作られたオブジェクトは別 realm なので、比較できる形に写す
      update: async (tabId, props) => { updatedTabs.push(JSON.parse(JSON.stringify([tabId, props]))); return {}; },
      query: async () => tabs,
      get: async () => ({}),
      sendMessage: () => {}
    },
    scripting: { executeScript: async () => {} },
    runtime: {
      onInstalled: event(), onStartup: event(), lastError: null,
      getManifest: () => JSON.parse(fs.readFileSync(path.join(__dirname, '../manifest.json'), 'utf8'))
    }
  };
  if (withWebNavigation) chrome.webNavigation = Object.fromEntries(NAV_EVENTS.map((name) => [name, event()]));
  const root = path.join(__dirname, '..');
  const context = vm.createContext({
    chrome, crypto: { randomUUID }, console: { log() {}, warn() {} }, setTimeout, clearTimeout, URL
  });
  context.globalThis = context;
  context.importScripts = (file) => vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), context);
  vm.runInContext(fs.readFileSync(path.join(root, 'background.js'), 'utf8'), context);
  const flush = async () => {
    await vm.runInContext('restoreGuardChain', context);
    await vm.runInContext('diagWriteChain', context);
  };
  return { chrome, store, sessionStore, updatedTabs, flush, failNextWrite: () => { failWrites++; } };
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

  const log = store.diag_nav_log.filter((e) => e.event === 'tab-updated');
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
  const updates = store.diag_nav_log.filter((e) => e.event === 'tab-updated');
  assert.deepEqual(updates.map((e) => e.parsed.index), Array.from({ length: 20 }, (_, i) => String(i + 1)));
  assert.deepEqual(updates.map((e) => e.sequence), Array.from({ length: 20 }, (_, i) => i + 2));
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

  const entry = store.diag_nav_log.find((e) => e.event === 'browser-startup');
  assert.equal(entry.event, 'browser-startup');
  assert.equal(entry.tabs.length, 1);
  assert.equal(entry.tabs[0].tabId, 5);
  assert.equal(entry.tabs[0].parsed.index, '1');
  assert.equal(entry.tabs[0].tabUrl, '');
  assert.equal(entry.tabs[0].pendingUrl, entry.tabs[0].url);
  assert.equal(entry.tabs[0].changeUrl, null);
  assert.ok(Number.isFinite(Date.parse(entry.snapshotRequestedAt)));
});

it('keeps committed and pending URLs distinct even when the legacy URL is identical', async () => {
  const { chrome, store, flush } = loadBackground();
  chrome.tabs.onCreated.fire({ id: 1, url: SECOND, status: 'unloaded' });
  chrome.tabs.onCreated.fire({ id: 2, url: '', pendingUrl: SECOND, status: 'unloaded' });
  chrome.tabs.onCreated.fire({ id: 3, url: FIRST, pendingUrl: SECOND, status: 'loading' });
  await flush();
  const created = store.diag_nav_log.filter((e) => e.event === 'tab-created');
  assert.equal(created[0].url, created[1].url);
  assert.deepEqual(created.map((e) => [e.tabUrl, e.pendingUrl]), [
    [SECOND, null], ['', SECOND], [FIRST, SECOND]
  ]);
  assert.equal(created[2].url, FIRST);
});

it('includes YouTube pending URLs hidden behind a committed URL in snapshots and tab updates', async () => {
  const tab = { id: 7, url: 'https://example.com/', pendingUrl: SECOND, status: 'loading' };
  const { chrome, store, flush } = loadBackground({ tabs: [tab] });
  chrome.tabs.onCreated.fire(tab);
  chrome.tabs.onUpdated.fire(7, { status: 'loading' }, tab);
  chrome.runtime.onStartup.fire();
  await new Promise((r) => setImmediate(r));
  await flush();
  const created = store.diag_nav_log.find((e) => e.event === 'tab-created');
  const updated = store.diag_nav_log.find((e) => e.event === 'tab-updated');
  const snapshot = store.diag_nav_log.find((e) => e.event === 'browser-startup');
  for (const entry of [created, updated, snapshot.tabs[0]]) {
    assert.equal(entry.tabUrl, 'https://example.com/');
    assert.equal(entry.pendingUrl, SECOND);
  }
});

it('separates changeInfo.url from tab.url and records load completion', async () => {
  const { chrome, store, flush } = loadBackground();
  chrome.tabs.onUpdated.fire(1, { url: SECOND }, { url: FIRST, pendingUrl: SECOND, status: 'loading' });
  chrome.tabs.onUpdated.fire(1, { status: 'complete' }, { url: SECOND, status: 'complete' });
  await flush();
  const [change, completed] = store.diag_nav_log.filter((e) => e.event === 'tab-updated');
  assert.equal(change.changeUrl, SECOND);
  assert.equal(change.tabUrl, FIRST);
  assert.equal(change.pendingUrl, SECOND);
  assert.equal(change.url, SECOND);
  assert.equal(change.tabStatus, 'loading');
  assert.equal(completed.status, 'complete');
  assert.equal(completed.changeUrl, null);
  assert.equal(completed.pendingUrl, null);
});

it('registers every navigation listener with permission and excludes subframes and other origins', async () => {
  const { chrome, store, flush } = loadBackground();
  assert.ok(chrome.runtime.getManifest().permissions.includes('webNavigation'));
  for (const name of NAV_EVENTS) {
    const apiEvent = chrome.webNavigation[name];
    // 診断ログに加えて、復元補正も onBeforeNavigate / onErrorOccurred / onCommitted を購読する
    assert.ok(apiEvent.registrations.length >= 1);
    for (const registration of apiEvent.registrations) {
      assert.deepEqual(JSON.parse(JSON.stringify(registration.filter)), {
        url: [{ hostEquals: 'www.youtube.com', schemes: ['https'] }]
      });
    }
    const details = { tabId: 1, frameId: 0, url: SECOND, timeStamp: 100 };
    apiEvent.fire({ ...details, frameId: 3 });
    apiEvent.fire({ ...details, url: 'https://example.com/' });
    apiEvent.fire({ ...details, url: 'http://www.youtube.com/watch?v=BXe7BA51a2U' });
    apiEvent.fire({ ...details, url: 'https://www.youtube.com.evil.test/' });
    apiEvent.fire(details);
  }
  await flush();
  const navigation = store.diag_nav_log.filter((e) => e.event.startsWith('webNavigation.'));
  assert.deepEqual(navigation.map((e) => e.event), NAV_EVENTS.map((name) => `webNavigation.${name}`));
  assert.ok(navigation.every((e) => e.frameId === 0 && e.url === SECOND));
  assert.deepEqual(store.diag_nav_log[0].navigationEvents, NAV_EVENTS);
});

it('retains document identity, redirect qualifiers, separate API time and errors', async () => {
  const { chrome, store, flush } = loadBackground();
  const details = {
    tabId: 1, frameId: 0, parentFrameId: -1, processId: 42, frameType: 'outermost_frame',
    url: SECOND, documentId: 'document-a', documentLifecycle: 'active', timeStamp: 1234.5,
    transitionType: 'reload', transitionQualifiers: ['server_redirect']
  };
  chrome.webNavigation.onCommitted.fire(details);
  details.transitionQualifiers.push('client_redirect');
  chrome.webNavigation.onHistoryStateUpdated.fire({ ...details, url: FIRST, timeStamp: 1240 });
  chrome.webNavigation.onErrorOccurred.fire({
    tabId: 1, frameId: 0, url: SECOND, timeStamp: 1250, error: 'net::ERR_ABORTED'
  });
  await flush();
  const [committed, history, error] = store.diag_nav_log.filter((e) => e.event.startsWith('webNavigation.'));
  assert.equal(committed.documentId, 'document-a');
  assert.equal(history.documentId, committed.documentId);
  assert.equal(history.url, FIRST);
  assert.deepEqual(committed.transitionQualifiers, ['server_redirect']);
  assert.equal(committed.transitionType, 'reload');
  assert.equal(committed.frameType, 'outermost_frame');
  assert.equal(committed.parentFrameId, -1);
  assert.equal(committed.processId, 42);
  assert.equal(committed.documentLifecycle, 'active');
  assert.equal(committed.navigationTimeStamp, 1234.5);
  assert.ok(Number.isFinite(Date.parse(committed.receivedAt)));
  assert.equal(committed.at, committed.receivedAt);
  assert.equal(error.error, 'net::ERR_ABORTED');
  assert.equal(error.documentId, null);
  assert.equal(error.transitionQualifiers, null);
});

it('preserves old logs and marks worker restarts with distinct identities and reset sequences', async () => {
  const legacy = { event: 'tab-updated', at: '2026-09-26T00:00:00Z', url: FIRST };
  const store = { diag_nav_log: [legacy] };
  const first = loadBackground({ store });
  first.chrome.tabs.onCreated.fire({ id: 1, url: FIRST });
  await first.flush();
  const second = loadBackground({ store });
  second.chrome.tabs.onCreated.fire({ id: 2, url: SECOND });
  await second.flush();
  assert.deepEqual(store.diag_nav_log[0], legacy);
  const [startA, eventA, startB, eventB] = store.diag_nav_log.slice(1);
  assert.equal(startA.event, 'diagnostic-start');
  assert.equal(startB.event, 'diagnostic-start');
  assert.notEqual(startA.workerId, startB.workerId);
  assert.equal(startA.workerId, eventA.workerId);
  assert.equal(startB.workerId, eventB.workerId);
  assert.deepEqual([startA.sequence, eventA.sequence, startB.sequence, eventB.sequence], [1, 2, 1, 2]);
  for (const entry of [startA, eventA, startB, eventB]) {
    assert.equal(entry.schemaVersion, 2);
    assert.equal(entry.extensionVersion, first.chrome.runtime.getManifest().version);
    assert.ok(Number.isFinite(Date.parse(entry.workerStartedAt)));
  }
});

it('retains at most 500 entries when navigation logging increases event volume', async () => {
  const { chrome, store, flush } = loadBackground();
  for (let i = 0; i < 510; i++) {
    chrome.webNavigation.onHistoryStateUpdated.fire({ tabId: 1, frameId: 0, url: SECOND, timeStamp: i });
  }
  await flush();
  assert.equal(store.diag_nav_log.length, 500);
  assert.equal(store.diag_nav_log[0].navigationTimeStamp, 10);
  assert.equal(store.diag_nav_log.at(-1).navigationTimeStamp, 509);
});

it('continues logging after a storage failure and exposes the missing sequence', async () => {
  const { chrome, store, flush, failNextWrite } = loadBackground();
  await flush();
  failNextWrite();
  chrome.tabs.onCreated.fire({ id: 1, url: FIRST });
  chrome.tabs.onCreated.fire({ id: 2, url: SECOND });
  await flush();
  assert.deepEqual(store.diag_nav_log.map((e) => e.sequence), [1, 3]);
  assert.equal(store.diag_nav_log[1].url, SECOND);
});

it('marks missing navigation API without disabling the existing tab logger', async () => {
  const { chrome, store, flush } = loadBackground({ withWebNavigation: false });
  chrome.tabs.onCreated.fire({ id: 1, url: SECOND });
  await flush();
  assert.deepEqual(store.diag_nav_log[0].navigationEvents, []);
  assert.equal(store.diag_nav_log[1].event, 'tab-created');
});

it('records an empty startup snapshot without claiming a restored URL', async () => {
  const { chrome, store, flush } = loadBackground();
  chrome.runtime.onStartup.fire();
  await new Promise((r) => setImmediate(r));
  await flush();
  const startup = store.diag_nav_log.find((e) => e.event === 'browser-startup');
  assert.deepEqual(startup.tabs, []);
});

// ---- 再起動後の復元先すり替えの補正 ----
// 10/13 に観測した並び: 復元タブ作成（#4, unloaded）→ #4 の読み込み開始 → ERR_ABORTED → 1ms 後に #2 の読み込み開始 → #2 確定
const RESTORED = 'https://www.youtube.com/watch?v=TSsKzpLjGZQ&list=PLej&index=4';
const SWAPPED = 'https://www.youtube.com/watch?v=YxsVe_nbfzc&list=PLej&index=2';

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
  const { chrome, store, updatedTabs, flush } = loadBackground();
  fireSwap(chrome);
  await flush();
  await flush();
  assert.deepEqual(updatedTabs, [[7, { url: RESTORED }]]);
  const corrected = store.diag_nav_log.find((e) => e.event === 'restore-corrected');
  assert.equal(corrected.replacementUrl, SWAPPED);
  assert.equal(corrected.url, RESTORED);
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
