// YouTube 再生位置自動保存 - Service Worker

'use strict';

// ────────────────────────────────────────────────────────────────
// [バックアップ] ブラウザ起動時・拡張機能更新時の content script 再注入ロジック
// 現在は content_scripts (manifest) による自動注入のみで運用しているため無効化。
// 再度必要になった場合はコメントを外し、manifest.json に
//   "permissions": ["scripting"],  "host_permissions": ["https://www.youtube.com/*"]
// を追加すること。
// ────────────────────────────────────────────────────────────────
//
// let needsInjection = false;
// const injectedTabs = new Set();
//
// async function injectIntoTab(tabId) {
//   if (injectedTabs.has(tabId)) return;
//   try {
//     const tab = await chrome.tabs.get(tabId);
//     if (!tab.url || !tab.url.startsWith('https://www.youtube.com/')) return;
//     if (tab.discarded) return;
//     injectedTabs.add(tabId);
//     await chrome.scripting.executeScript({
//       target: { tabId },
//       files: ['content.js']
//     });
//     console.log(`[YouTube再生位置保存] SW: タブ ${tabId} にスクリプトを注入`);
//   } catch (e) {
//     injectedTabs.delete(tabId);
//     console.warn(`[YouTube再生位置保存] SW: タブ ${tabId} への注入失敗:`, e.message || e);
//   }
// }
//
// chrome.tabs.onActivated.addListener((activeInfo) => {
//   if (!needsInjection) return;
//   injectIntoTab(activeInfo.tabId);
// });
//
// chrome.tabs.onRemoved.addListener((tabId) => {
//   injectedTabs.delete(tabId);
// });
//
// chrome.runtime.onStartup.addListener(() => {
//   console.log('[YouTube再生位置保存] SW: ブラウザ起動を検出');
//   needsInjection = true;
// });
//
// chrome.runtime.onInstalled.addListener((details) => {
//   console.log(`[YouTube再生位置保存] SW: ${details.reason} を検出`);
//   needsInjection = true;
// });
