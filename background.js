// YouTube 再生位置自動保存 - Service Worker
// ブラウザ起動時・拡張機能インストール/更新時に
// 既存のYouTubeタブへ content script を再注入する

'use strict';

/**
 * 既に開いているYouTubeタブに content.js を注入する
 * ブラウザ再起動時、content_scripts の自動注入が間に合わない
 * （タブが復元済みだが content script が未ロード）ケースを補う
 */
async function injectIntoExistingTabs() {
  try {
    const tabs = await chrome.tabs.query({ url: 'https://www.youtube.com/*' });

    for (const tab of tabs) {
      // discarded（未読み込み）タブはクリック時に自動注入されるのでスキップ
      if (tab.discarded) continue;

      try {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ['content.js']
        });
        console.log(`[YouTube再生位置保存] SW: タブ ${tab.id} にスクリプトを注入`);
      } catch (e) {
        // タブが特殊な状態（クラッシュページ等）の場合は無視
        console.warn(`[YouTube再生位置保存] SW: タブ ${tab.id} への注入失敗:`, e.message || e);
      }
    }
  } catch (e) {
    console.warn('[YouTube再生位置保存] SW: タブ一覧の取得に失敗:', e.message || e);
  }
}

// ブラウザ起動時（再起動・プロファイル読み込み時）
chrome.runtime.onStartup.addListener(() => {
  console.log('[YouTube再生位置保存] SW: ブラウザ起動を検出');
  injectIntoExistingTabs();
});

// 拡張機能のインストール・更新時
chrome.runtime.onInstalled.addListener((details) => {
  console.log(`[YouTube再生位置保存] SW: ${details.reason} を検出`);
  // install / update どちらでも既存タブに注入
  injectIntoExistingTabs();
});
