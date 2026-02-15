# YouTube 再生位置自動保存 - 更新履歴

## [1.6.0] - 2026-02-16

### 追加
- **既存タブ切替**：ポップアップから動画を開く際、同じ動画のタブが既に開かれていればそちらに切り替え（なければ新規タブ）
- **検索機能**：ポップアップに検索バーを追加。タイトルまたは動画IDでリアルタイム絞り込みが可能

### 変更
- `popup.html` に検索入力欄を追加
- `popup.css` に検索バーのスタイルを追加
- `popup.js` の `applyI18n` を `data-i18n-placeholder` 属性に対応
- i18n メッセージに `popupSearchPlaceholder` を追加（日本語・英語）

---

## [1.5.0] - 2026-02-16

### 追加
- **ブラウザ再起動対応**：Service Worker（`background.js`）を追加し、ブラウザ再起動時・拡張機能更新時に既存のYouTubeタブへ content script を自動再注入
- `content.js` に多重注入防止ガード（`window.__ytPositionSaverLoaded`）を追加

### 改善
- 例外処理の空 `catch` を `console.warn` に置換し、障害原因の追跡性を向上
- `savePositionCore` を `async` 化し、`chrome.storage.local.set` を `await` で保存完了を保証
- `loadedmetadata` コールバック内でクロージャ変数（`capturedVideoId`）を使用し、急速連続遷移時のコンテキスト混線を防止
- `video.play()` 失敗時にエラー理由をログ出力するように変更

### 変更
- `manifest.json` に `scripting` 権限と `background.service_worker` を追加

---

## [1.4.0] - 2026-02-16

### 追加
- **ポップアップUI**：ツールバーアイコンから保存済み動画の一覧表示・個別削除・一括削除・有効/無効切替が可能に
- **多言語対応（i18n）**：日本語（デフォルト）・英語に対応。ブラウザの言語設定に自動追従
- `_locales/ja/messages.json`、`_locales/en/messages.json` を追加
- `popup.html`、`popup.js`、`popup.css` を追加

### 修正
- `seeked` イベントにタイムアウト（3秒）を追加し、イベントが発火しない場合でもフォールバックで復元処理を続行するように修正（Promise の永久ブロックを防止）

### 変更
- `manifest.json` の `name` / `description` を `__MSG_*__` 形式に変更（i18n対応）
- `manifest.json` に `default_locale`、`action.default_popup` を追加

---

## [1.3.1] - 2025-12-14

### 修正
- 戻る/進む（popstate）などで `init()` が二重実行されやすいケースを抑止し、遷移時保存を安定化

## [1.3.0] - 2025-12-14

### 変更
- READMEの内容を公開向けに整理（機能説明、権限、保存データ、ストア掲載用説明文を追加）
- バージョン表記を `manifest.json`（1.3.0）に合わせて整合

## [1.2.0] - 2025-11-26

### 追加
- 復元中フラグ（`isRestoring`）によるイベント競合防止
- 動画要素検出時の即時一時停止（最初の数秒再生を防止）
- シーク完了を Promise で確実に待機

### 改善
- マジックナンバーを定数化（`VIDEO_CHECK_INTERVAL_MS`, `NOTIFICATION_DURATION_MS` など）
- `videoCheckIntervalId` のクリーンアップ漏れを修正
- イベントリスナーの適切な削除（メモリリーク防止）
- `yt-navigate-finish` イベント使用（MutationObserver より効率的）
- `async/await` による競合状態の解消

---

## [1.1.0] - 2025-11-26

### 追加
- `timeupdate` イベントで常に最新の再生位置を追跡
- 戻るボタン押下時の再生位置保存
- 無効な値（0秒/NaN秒）の保存防止

### 改善
- 一時停止中の重複保存を防止
- `Extension context invalidated` エラーのハンドリング

---

## [1.0.0] - 2025-11-26

### 機能
- YouTube 動画の再生位置を自動保存
- 5秒ごとの定期保存
- ページ再読み込み時に復元
- 再訪問時に復元
- 戻る/進むボタンでの復元
- 動画終了時にデータ削除
- 動画の長さチェック（差異が5秒以上の場合はスキップ）
- 復元時のトースト通知表示

### 保存トリガー
- 5秒ごとの定期保存
- 一時停止時
- ページ遷移時
- タブ切り替え時
- ページ離脱時

---

## 技術仕様

### 使用 API
- `chrome.storage.local` - 再生位置の保存
- `chrome.runtime.id` - 拡張機能の有効性チェック
- `chrome.scripting.executeScript` - 再起動時のスクリプト再注入
- `chrome.runtime.onStartup` - ブラウザ起動検出
- `chrome.runtime.onInstalled` - 拡張機能インストール/更新検出
- `chrome.tabs.query` - 既存タブの取得

### イベント
- `yt-navigate-finish` - YouTube SPA ナビゲーション検出
- `popstate` - 戻る/進むボタン検出
- `visibilitychange` - タブ切り替え検出
- `beforeunload` - ページ離脱検出
- `timeupdate` - 再生位置追跡
- `pause` - 一時停止検出
- `ended` - 動画終了検出
- `seeked` - シーク完了検出
- `loadedmetadata` - メタデータ読み込み完了

### 定数
| 定数名 | 値 | 説明 |
|--------|-----|------|
| `SAVE_INTERVAL_MS` | 5000 | 定期保存間隔（ms） |
| `VIDEO_CHECK_INTERVAL_MS` | 100 | 動画要素チェック間隔（ms） |
| `VIDEO_CHECK_TIMEOUT_MS` | 5000 | チェックタイムアウト（ms） |
| `NOTIFICATION_DURATION_MS` | 3000 | 通知表示時間（ms） |
| `NOTIFICATION_FADE_MS` | 500 | 通知フェードアウト時間（ms） |
| `MIN_VALID_DURATION` | 1 | 最小有効動画長（秒） |
| `MIN_SAVE_TIME` | 0 | 最小保存時間（秒） |
| `DURATION_DIFF_THRESHOLD` | 5 | 動画長さ差異許容値（秒） |
| `POPSTATE_INIT_DELAY_MS` | 300 | popstate 後の初期化遅延（ms） |
| `SEEKED_TIMEOUT_MS` | 3000 | seeked イベントのタイムアウト（ms） |
| `SETTINGS_KEY` | `yt_position_settings` | 設定用ストレージキー |
