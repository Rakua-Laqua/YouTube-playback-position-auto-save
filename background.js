// YouTube 再生位置自動保存 - Service Worker

'use strict';

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

chrome.runtime.onInstalled.addListener((details) => {
  injectIntoYouTubeTabs(details.reason || 'installed');
});

chrome.runtime.onStartup.addListener(() => {
  injectIntoYouTubeTabs('startup');
});
