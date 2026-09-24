// YouTube 再生位置自動保存 - Service Worker

'use strict';

// 診断ログの共通処理（キー名・リングバッファ・URL解析）を content/popup と共有する
importScripts('shared.js');
const Shared = globalThis.YtPositionSaverShared;

const YOUTUBE_URL_PATTERN = 'https://www.youtube.com/*';
const YOUTUBE_URL_PREFIX = 'https://www.youtube.com/';
const PING_MESSAGE_TYPE = 'yt-position-saver-ping';
const PING_TIMEOUT_MS = 500;

function isYouTubeTab(tab) {
  return !!tab?.url && tab.url.startsWith(YOUTUBE_URL_PREFIX);
}

function pingContentScript(tabId) {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(false);
    }, PING_TIMEOUT_MS);

    try {
      chrome.tabs.sendMessage(tabId, { type: PING_MESSAGE_TYPE }, (response) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (chrome.runtime.lastError) {
          resolve(false);
          return;
        }
        resolve(!!response?.ok);
      });
    } catch (e) {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve(false);
      }
    }
  });
}

async function injectIntoTab(tabId, reason) {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!isYouTubeTab(tab)) return;
    if (tab.discarded) return;

    const alive = await pingContentScript(tabId);
    if (alive) {
      console.log(`[YouTube再生位置保存] SW: content script 生存確認済み (${reason}) tab=${tabId}`);
      return;
    }

    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['shared.js', 'content.js']
    });

    console.log(`[YouTube再生位置保存] SW: content script を再注入 (${reason}) tab=${tabId}`);
  } catch (e) {
    console.warn(`[YouTube再生位置保存] SW: 再注入失敗 (${reason}) tab=${tabId}:`, e.message || e);
  }
}

async function injectIntoYouTubeTabs(reason) {
  try {
    const tabs = await chrome.tabs.query({ url: YOUTUBE_URL_PATTERN });
    await Promise.all(tabs.map((tab) => injectIntoTab(tab.id, reason)));
  } catch (e) {
    console.warn(`[YouTube再生位置保存] SW: YouTubeタブ検索失敗 (${reason}):`, e.message || e);
  }
}

// ---- 診断ログ ----
// 目的: プレイリストを長時間再生した後に Chrome を再起動すると先頭の動画に戻ることがある件で、
// 「Chrome が古い URL を復元した」のか「正しい URL で開いた後に YouTube が先頭へ移った」のかを切り分ける。
// Chrome のセッション復元が使うのはタブの URL なので、ページ内ではなく tabs API から見た URL を記録する。
// tabs.onRemoved は記録しない。Chrome 終了時は Service Worker の非同期書き込みが完了する保証がなく、
// 記録の有無から終了の仕方を判断できないため。

function isYouTubeUrl(url) {
  return typeof url === 'string' && url.startsWith(YOUTUBE_URL_PREFIX);
}

function describeUrl(url) {
  return { url, parsed: Shared.parseWatchUrl(url) };
}

function describeTab(tab) {
  // 起動直後の未読み込みタブは url が空で pendingUrl だけを持つことがある
  const url = tab.url || tab.pendingUrl || '';
  return {
    tabId: tab.id,
    windowId: tab.windowId,
    status: tab.status,
    discarded: !!tab.discarded,
    active: !!tab.active,
    ...describeUrl(url)
  };
}

// 読み込み→追記→書き込みが並行すると記録が消えるため、この Service Worker 内で直列化する。
// popup の「削除」とは排他していないが、競合しても失うのは削除直前の数件なので許容する。
let diagWriteChain = Promise.resolve();

function recordDiag(event, data) {
  const entry = { at: new Date().toISOString(), event, ...data };
  diagWriteChain = diagWriteChain
    .then(async () => {
      const stored = await chrome.storage.local.get(Shared.DIAG_LOG_KEY);
      const next = Shared.appendDiagEntry(stored[Shared.DIAG_LOG_KEY], entry);
      await chrome.storage.local.set({ [Shared.DIAG_LOG_KEY]: next });
    })
    .catch((e) => {
      console.warn('[YouTube再生位置保存] SW: 診断ログの記録失敗:', e.message || e);
    });
  return diagWriteChain;
}

// Chrome が復元した時点の YouTube タブの URL を残す（このあとの YouTube 側の遷移と区別するため）
async function recordYouTubeTabsSnapshot(event) {
  try {
    const tabs = await chrome.tabs.query({});
    const youTubeTabs = tabs.filter((tab) => isYouTubeUrl(tab.url || tab.pendingUrl));
    await recordDiag(event, { tabs: youTubeTabs.map(describeTab) });
  } catch (e) {
    console.warn(`[YouTube再生位置保存] SW: タブ一覧の記録失敗 (${event}):`, e.message || e);
  }
}

chrome.tabs.onCreated.addListener((tab) => {
  if (!isYouTubeUrl(tab.url || tab.pendingUrl)) return;
  void recordDiag('tab-created', describeTab(tab));
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  // タイトルや音声状態の変化は記録しない。URL の変化（プレイリストの次の動画への移動も含む）、
  // ページの読み込み開始（復元・再読み込み）、タブの破棄だけを残す。
  const urlChanged = typeof changeInfo.url === 'string';
  const loading = changeInfo.status === 'loading';
  const discardChanged = typeof changeInfo.discarded === 'boolean';
  if (!urlChanged && !loading && !discardChanged) return;

  const url = changeInfo.url || tab?.url || '';
  if (!isYouTubeUrl(url)) return;

  void recordDiag('tab-updated', {
    tabId,
    urlChanged,
    status: changeInfo.status,
    discarded: discardChanged ? changeInfo.discarded : undefined,
    ...describeUrl(url)
  });
});

chrome.runtime.onInstalled.addListener((details) => {
  injectIntoYouTubeTabs(details.reason || 'installed');
  void recordYouTubeTabsSnapshot(`extension-${details.reason || 'installed'}`);
});

chrome.runtime.onStartup.addListener(() => {
  injectIntoYouTubeTabs('startup');
  void recordYouTubeTabsSnapshot('browser-startup');
});
