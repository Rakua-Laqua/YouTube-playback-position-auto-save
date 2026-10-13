'use strict';

// 手動実行用。実際の Chrome 拡張 API を使うが、ページは通信を差し替えた検証用 HTML のみ。
// 普段のプロファイルを引数に取らず、毎回作成する一時プロファイルだけを操作する。
// usage: node tests/browser-diag-smoke.cjs <playwright module> <Chromium/Chrome for Testing executable> [result.json]
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { chromium } = require(process.argv[2] || 'playwright');

const FIRST = 'https://www.youtube.com/watch?v=D4_aoCd7hwQ&list=PLdiag';
const SECOND = 'https://www.youtube.com/watch?v=BXe7BA51a2U&list=PLdiag&index=2';
const REDIRECT = 'https://www.youtube.com/diag-redirect';
const ERROR = 'https://www.youtube.com/diag-error';
const CHILD = 'https://www.youtube.com/diag-child';
const OTHER = 'https://example.com/diag';
const NAV_EVENTS = [
  'onBeforeNavigate', 'onCommitted', 'onDOMContentLoaded', 'onHistoryStateUpdated',
  'onReferenceFragmentUpdated', 'onCompleted', 'onErrorOccurred'
];

async function waitForLog(worker, predicate) {
  const deadline = Date.now() + 10000;
  do {
    const entries = await worker.evaluate(async () => {
      const stored = await chrome.storage.local.get('diag_nav_log');
      return stored.diag_nav_log || [];
    });
    if (predicate(entries)) return entries;
    await delay(50);
  } while (Date.now() < deadline);
  throw new Error('Timed out waiting for diagnostic evidence');
}

async function main() {
  const extensionPath = path.resolve(__dirname, '..');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'yt-nav-diag-smoke-'));
  const context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium',
    executablePath: process.argv[3] || undefined,
    headless: true,
    ignoreDefaultArgs: ['--disable-extensions'],
    args: [
      `--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`,
      // interception が抜けても実サービスへ到達させない。
      '--host-resolver-rules=MAP www.youtube.com ~NOTFOUND, MAP example.com ~NOTFOUND'
    ]
  });
  try {
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    const fixtureErrors = [];
    const intercepted = new Set();
    // CDP Fetch はリダイレクト後のリクエストも個別に通知する。全段階を fixture で完結させる。
    async function serveFixture({ requestId, request }) {
      const url = request.url;
      intercepted.add(url);
      if (url === REDIRECT) {
        return cdp.send('Fetch.fulfillRequest', {
          requestId, responseCode: 302,
          responseHeaders: [{ name: 'Location', value: FIRST }, { name: 'Cache-Control', value: 'no-store' }],
          body: ''
        });
      }
      if (url === ERROR) return cdp.send('Fetch.failRequest', { requestId, errorReason: 'Failed' });
      if ([FIRST, SECOND, CHILD, OTHER].includes(url)) {
        const iframe = [FIRST, SECOND].includes(url) ? `<iframe src="${CHILD}"></iframe>` : '';
        return cdp.send('Fetch.fulfillRequest', {
          requestId, responseCode: 200,
          responseHeaders: [{ name: 'Content-Type', value: 'text/html' }, { name: 'Cache-Control', value: 'no-store' }],
          body: Buffer.from(`<!doctype html><title>Navigation diagnostic fixture</title><main>Fixture</main>${iframe}`).toString('base64')
        });
      }
      return cdp.send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' });
    }
    cdp.on('Fetch.requestPaused', (request) => {
      void serveFixture(request).catch((error) => fixtureErrors.push(error));
    });
    await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] });
    let [worker] = context.serviceWorkers();
    if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15000 });
    const initial = await waitForLog(worker, (entries) => entries.some((e) => e.event === 'diagnostic-start'));
    const start = initial.find((e) => e.event === 'diagnostic-start');
    assert.equal(start.schemaVersion, 2);
    assert.deepEqual(start.navigationEvents, NAV_EVENTS);

    await page.goto(REDIRECT, { timeout: 10000 });
    let entries = await waitForLog(worker, (log) => log.some((e) => e.event === 'webNavigation.onCompleted' && e.url === FIRST));
    const committed = entries.find((e) => e.event === 'webNavigation.onCommitted' && e.url === FIRST);
    assert.ok(committed.documentId);
    assert.ok(committed.transitionQualifiers.includes('server_redirect'));

    // 自作 HTML にのみ History API を実行する。実際の YouTube ページは操作しない。
    await page.evaluate((url) => history.pushState({ diagnostic: true }, '', url), SECOND);
    entries = await waitForLog(worker, (log) => log.some((e) => e.event === 'webNavigation.onHistoryStateUpdated' && e.url === SECOND));
    const historyUpdate = entries.find((e) => e.event === 'webNavigation.onHistoryStateUpdated' && e.url === SECOND);
    assert.equal(historyUpdate.documentId, committed.documentId);

    await page.reload();
    entries = await waitForLog(worker, (log) => log.some((e) => e.event === 'webNavigation.onCompleted' && e.url === SECOND));
    const reloaded = entries.find((e) => e.event === 'webNavigation.onCommitted' && e.url === SECOND);
    assert.notEqual(reloaded.documentId, committed.documentId);
    assert.equal(reloaded.transitionType, 'reload');

    await page.goto(ERROR).catch(() => {});
    entries = await waitForLog(worker, (log) => log.some((e) => e.event === 'webNavigation.onErrorOccurred' && e.url === ERROR));
    const error = entries.find((e) => e.event === 'webNavigation.onErrorOccurred' && e.url === ERROR);
    assert.ok(error.error);

    await page.goto(OTHER);
    // 書き込み待ちの末尾まで確認してから「対象外イベントがない」を判定する。
    await worker.evaluate(async () => { await diagWriteChain; });
    entries = await worker.evaluate(async () => (await chrome.storage.local.get('diag_nav_log')).diag_nav_log);
    const navigation = entries.filter((e) => e.event.startsWith('webNavigation.'));
    assert.ok(navigation.every((e) => e.frameId === 0));
    assert.ok(navigation.every((e) => e.url !== CHILD && e.url !== OTHER));
    assert.ok(navigation.every((e) => typeof e.navigationTimeStamp === 'number'));
    assert.ok(navigation.every((e) => Number.isFinite(Date.parse(e.receivedAt))));
    assert.deepEqual(fixtureErrors, []);
    for (const url of [REDIRECT, FIRST, SECOND, CHILD, ERROR, OTHER]) assert.ok(intercepted.has(url));

    const result = {
      testedAt: new Date().toISOString(),
      browserVersion: context.browser().version(),
      fixtureOnly: true,
      userProfileUsed: false,
      checks: {
        listenersRegistered: true,
        serverRedirectObserved: true,
        historyUpdatePreservesDocumentId: true,
        reloadChangesDocumentId: true,
        navigationErrorObserved: true,
        subframesAndOtherOriginsExcluded: true
      },
      navigationEntryCount: navigation.length,
      sample: { start, committed, historyUpdate, reloaded, error }
    };
    if (process.argv[4]) fs.writeFileSync(process.argv[4], JSON.stringify(result, null, 2) + '\n');
    console.log(JSON.stringify({ ...result, sample: undefined }, null, 2));
  } finally {
    await context.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
