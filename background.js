// YouTube 再生位置自動保存 - Service Worker

'use strict';

const YOUTUBE_URL_PATTERN = 'https://www.youtube.com/*';
const YOUTUBE_URL_PREFIX = 'https://www.youtube.com/';

function isYouTubeTab(tab) {
  return !!tab?.url && tab.url.startsWith(YOUTUBE_URL_PREFIX);
}

async function injectIntoTab(tabId, reason) {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!isYouTubeTab(tab)) return;
    if (tab.discarded) return;

    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content.js']
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

chrome.tabs.onActivated.addListener((activeInfo) => {
  injectIntoTab(activeInfo.tabId, 'activated');
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete') return;
  if (!isYouTubeTab(tab)) return;

  injectIntoTab(tabId, 'updated');
});
