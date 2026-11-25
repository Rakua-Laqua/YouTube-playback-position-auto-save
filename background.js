// YouTube 再生位置自動保存 - Service Worker

'use strict';

// 設定正規化と URL 解析の共通処理を content/popup と共有する
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

function isYouTubeUrl(url) {
  return typeof url === 'string' && url.startsWith(YOUTUBE_URL_PREFIX);
}

// ---- 再起動後の復元先すり替えの補正 ----
// Chrome は再起動時、プレイリストのタブを正しい URL（最後に見ていた動画）で作って読み込みを始める。
// ところが文書ができる前にその読み込みを ERR_ABORTED で打ち切り、1〜2ms 後に、ユーザーが最後に操作した
// 動画の URL を読み込み直すことがある。自動再生で次の動画へ進んだ分（ユーザー操作のない pushState）が失われる。
// 経緯は docs/playlist-restore-investigation.md。
// すり替えは文書ができる前に起きるので、コンテンツスクリプトでは防げない。ブラウザ側のイベントで並びを検出し、
// すり替え後の読み込みが確定してから、Chrome が最初に復元した URL へ移動し直す。
// 背面の復元タブは選択されるまで読み込まれず、その間に Service Worker が止まることがある。
// そのため、監視の状態は storage.session（ブラウザを閉じるまで保持）に置く。
const RESTORE_GUARD_KEY = 'restoreGuardTabs';
const SETTINGS_KEY = 'yt_position_settings';
// 観測では中断から次の読み込み開始まで 1〜2ms。ユーザーの操作が割り込めない短さに限定して誤検出を避ける。
const RESTORE_SWAP_MAX_GAP_MS = 1000;

let restoreGuards = null;
let restoreGuardChain = Promise.resolve();

function isWatchUrl(url) {
  const parsed = Shared.parseWatchUrl(url);
  return isYouTubeUrl(url) && parsed?.path === '/watch' && !!parsed.v;
}

// 状態の読み書きを直列化する。イベントは連続して届き、読み込み→更新→保存が並行すると状態が巻き戻るため。
function updateRestoreGuards(mutator) {
  restoreGuardChain = restoreGuardChain
    .then(async () => {
      if (!restoreGuards) {
        const stored = await chrome.storage.session.get(RESTORE_GUARD_KEY);
        restoreGuards = stored[RESTORE_GUARD_KEY] || {};
      }
      const changed = await mutator(restoreGuards);
      if (changed) await chrome.storage.session.set({ [RESTORE_GUARD_KEY]: restoreGuards });
    })
    .catch((e) => {
      console.warn('[YouTube再生位置保存] SW: 復元補正の状態更新失敗:', e.message || e);
    });
  return restoreGuardChain;
}

async function isExtensionEnabled() {
  const stored = await chrome.storage.local.get(SETTINGS_KEY);
  return Shared.normalizeSettings(stored[SETTINGS_KEY]).enabled !== false;
}

chrome.tabs.onCreated.addListener((tab) => {
  // 復元されたタブは未読み込み（unloaded）で作られる。リンクや新規タブは loading なので対象にしない。
  const url = tab.url || tab.pendingUrl || '';
  if (tab.status !== 'unloaded' || !isWatchUrl(url)) return;
  void updateRestoreGuards((guards) => {
    guards[tab.id] = { url, phase: 'created' };
    return true;
  });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void updateRestoreGuards((guards) => {
    if (!(tabId in guards)) return false;
    delete guards[tabId];
    return true;
  });
});

// 想定した並び（作成→同じURLの読み込み開始→中断→直後に別URLの読み込み開始→確定）から外れたら監視をやめる。
// 正しく復元された場合も、確定した時点で監視は終わる。
function advanceRestoreGuard(kind, details) {
  if (details.frameId !== 0) return;
  void updateRestoreGuards(async (guards) => {
    const guard = guards[details.tabId];
    if (!guard) return false;
    const drop = () => { delete guards[details.tabId]; return true; };

    if (kind === 'onBeforeNavigate') {
      if (guard.phase === 'created' && details.url === guard.url) {
        guard.phase = 'started';
        return true;
      }
      const gap = details.timeStamp - guard.abortedAt;
      if (guard.phase === 'aborted' && details.url !== guard.url && gap >= 0 && gap <= RESTORE_SWAP_MAX_GAP_MS) {
        guard.phase = 'swapped';
        guard.replacementUrl = details.url;
        return true;
      }
      return drop();
    }

    if (kind === 'onErrorOccurred') {
      if (guard.phase === 'started' && details.url === guard.url && details.error === 'net::ERR_ABORTED') {
        guard.phase = 'aborted';
        guard.abortedAt = details.timeStamp;
        return true;
      }
      return drop();
    }

    // onCommitted
    const corrected = guard.phase === 'swapped' && details.url === guard.replacementUrl;
    drop();
    if (!corrected) return true;
    if (!(await isExtensionEnabled())) return true;
    try {
      await chrome.tabs.update(details.tabId, { url: guard.url });
      console.log(`[YouTube再生位置保存] SW: 復元先のすり替えを補正 tab=${details.tabId}`);
    } catch (e) {
      console.warn(`[YouTube再生位置保存] SW: 復元先の補正失敗 tab=${details.tabId}:`, e.message || e);
    }
    return true;
  });
}

for (const kind of ['onBeforeNavigate', 'onErrorOccurred', 'onCommitted']) {
  chrome.webNavigation?.[kind]?.addListener(
    (details) => advanceRestoreGuard(kind, details),
    { url: [{ hostEquals: 'www.youtube.com', schemes: ['https'] }] }
  );
}

chrome.runtime.onInstalled.addListener((details) => {
  injectIntoYouTubeTabs(details.reason || 'installed');
});

chrome.runtime.onStartup.addListener(() => {
  injectIntoYouTubeTabs('startup');
});
