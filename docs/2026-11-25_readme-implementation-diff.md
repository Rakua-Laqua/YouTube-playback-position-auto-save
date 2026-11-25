# README と実装の差分調査（2026-11-25）

対象: `README.md`、`README.en.md` と現行ソースコード（`manifest.json`, `package.json`, `shared.js`, `background.js`, `content.js`, `popup.html`, `popup.js`, `_locales/*/messages.json`）の照合結果。

比較基準は現行リポジトリの実装コードとする。各項目には、README を読んだ利用者・開発者の判断や操作にどれだけ影響するかを示す影響度（高・中・低）を付記する。

## 1. 明確な誤り・記載漏れ

### 1-1. バージョン表記の不一致と README 内部の矛盾（影響度: 高）

- **README の記述**: `README.md` および `README.en.md` の見出しは `v1.10.1`（L1）、末尾のバージョン節は `1.9.2`（L210）となっている。
- **実装の根拠**: `manifest.json`（L4）と `package.json`（L3）のバージョンは `1.10.3` であり、`CHANGELOG.md`（L3）の最新エントリも `1.10.3` である。
- **問題点**: README の冒頭と末尾でバージョンが食い違っており、どちらも現行バージョン `1.10.3` と一致していない。

### 1-2. 保存先ストレージと保存データ構造の食い違い（影響度: 高）

- **README の記述**: 冒頭（L7）で「保存データは `chrome.storage.local` にのみ記録され、外部サーバーへ送信されません」とし、「保存されるデータ」（L128-140）では `yt_position_<動画ID>`（動画 ID・再生位置・動画の長さ・保存時刻・ページタイトル）と `yt_position_settings` の 2 種のみを記載している。
- **実装の根拠**:
  - `chrome.storage.local` には、上記 2 種に加えて診断ログ用キー `diag_nav_log` が保存されている（`shared.js` L291、`background.js` L150-152）。README では「権限」節末尾（L156）に最大 500 件の端末内保存とだけ触れられており、「保存されるデータ」節に記載がない。
  - 再起動後の復元先すり替え補正の監視状態は、`chrome.storage.session` のキー `restoreGuardTabs` に保存されている（`background.js` L244, L262-266）。外部サーバーへ送信されない点は一致しているが、`chrome.storage.local` のみに記録されるという説明とは異なる。
  - `yt_position_<動画ID>` の値オブジェクトに保存されるプロパティは `position`, `duration`, `timestamp`, `title` の 4 項目のみであり（`content.js` L449-454、`popup.js` L395-400）、`videoId` は値側には保存されずキー名から復元されている（`popup.js` L133-137）。

### 1-3. URL タイムスタンプパラメータ（`?t=`, `?start=`）時の復元スキップが未記載（影響度: 高）

- **README の記述**: 「復元されないケース」（L56-68）および「注意事項」（L174-180）に、URL の開始位置指定に関する記載がない（`README.en.md` も同様）。
- **実装の根拠**: `content.js` の `prepareAndRestore`（L863-870）は `Shared.hasUrlTimestamp(urlParams)` を呼び出し、URL クエリ `t` または `start` に正の秒数指定（例: `120`, `120s`, `1m30s`, `1h2m3s`、`shared.js` L244-276）がある場合は YouTube 標準のシーク再生を優先して復元をスキップし、通常どおり保存のみ開始する。

### 1-4. 設定画面の「診断ログ（一時的）」セクションが機能・設定一覧から欠落（影響度: 中〜高）

- **README の記述**: 「ポップアップでできること」（L72-90）と「設定項目」（L91-119）には「保存と復元」「一覧とデータ」「データ管理」の 3 セクションのみが記載されている。
- **実装の根拠**: `popup.html`（L132-139）には 4 つ目のセクションとして「診断ログ（一時的）」（`settingsSectionDiag`）があり、`popup.js`（L353-379, L477-478）で `diag_nav_log` を別ファイル（`youtube-position-saver-diag-YYYY-MM-DD.json`）として書き出す処理（`exportDiagLog`）と削除する処理（`clearDiagLog`）を実装している。

### 1-5. ファイル構成ツリーの欠落および役割説明の陳腐化（影響度: 中）

- **README の記述**: 「ファイル構成」（`README.md` / `README.en.md` L182-202）ではルート名を `Youtube再生位置自動保存/` とし、`background.js` を「Service Worker（インストール/起動時の再注入）」、`shared.js` を「設定・動画データの共通スキーマ検証」、`tests/` を「`node:test` による単体テスト」と記載している。
- **実装の根拠**:
  - 実際のリポジトリ名・ディレクトリ名は `YouTube-playback-position-auto-save/` である。
  - `manifest.json`（L19-33）で参照している必須アセット `icons/` と、README 自身がリンクしている `docs/`（L18, L156）がツリーから抜けている。
  - `background.js` は再注入処理（L14-78）に加え、診断ログ収集（L80-233, L356-370）と再起動後の復元先すり替え補正（L235-354）がコードの大半を占めている。
  - `shared.js` はスキーマ検証（L27-162）に加え、セッション世代管理・復元状態遷移・一時消音解除（L164-241, L278-286）、URL タイムスタンプ解析（L243-276）、診断ログ共通関数（L288-319）を含んでいる。
  - `tests/` には `node:test` による単体テスト 4 本のほか、Playwright を用いた手動実ブラウザ検証スクリプト `tests/browser-diag-smoke.cjs` が含まれる（`package.json` L7 の `npm test` 対象外）。

---

## 2. 振る舞いの細部・スコープ・副作用における差異

### 2-1. 復元スキップ条件に伴うデータ削除と、未記載のスキップ条件（影響度: 中）

- **README の記述**: 「復元されないケース」（L56-68）は「復元を行いません」とだけ説明し、広告再生時（L70）は「広告終了後に復元を再試行します」としている。
- **実装の根拠**:
  - `content.js` の `validateRestoreCandidate`（L609-613）では、`prepareAndRestore` を通過した後に `isRestorableCurrentVideo` が偽（配信中ライブと判定された場合や `duration` が無効/1 秒未満の場合）になると、単なるスキップではなく `removeStoredPosition` を呼んで既存の保存データを削除する（無効保存データ時の L591-595 も削除経路を持つが、事前判定 L889 により通常は到達しない）。
  - `loadStoredRestoreData`（L580）は `if (!data || !data.position)` で判定しているため、`position === 0` の保存データは復元対象外としてスキップされる。
  - `scheduleRestoreAfterAd`（L327-332）は広告終了待ちが `AD_RESTORE_MAX_WAIT_MS`（120 秒）を超えると復元をスキップする（定数表 L169 に上限値は記載されているが、L70 本文にはタイムアウト時のスキップ動作が未記載）。
  - `loadSettings` / `isEnabled`（L830-849）では設定の読み込み自体に失敗した場合も、安全側として保存・復元を停止する。

### 2-2. 復元時の音漏れ防止（一時消音）と早期準備処理の未記載（影響度: 中）

- **README の記述**: 復元処理は「一時停止してからシークし、設定に応じて再生を再開」（L15, L38）、スクリプト注入は「`content_scripts` による自動注入」（L154）と記載されている。
- **実装の根拠**:
  - `manifest.json`（L39）は `"run_at": "document_start"` を指定し、ページ読み込み初期から注入している。
  - `content.js` の `beginSession`（L108-114）は動画 ID 検出直後に `chrome.storage.local.get` を先行プリフェッチする。
  - `prepareAndRestore`（L872-905）は、広告や配信中ライブでなく元々ミュートでない場合、ストレージ読み込み待ち〜シーク完了までの間 `targetVideo.muted = true` で一時消音し、冒頭の音漏れを防ぐ。元のミュート状態は完了・スキップ・セッション終了時に `Shared.unmarkPreMute`（`shared.js` L279-286）で復元される。

### 2-3. 「終了 3 秒以内」の終了判定が遷移・非表示・離脱時の保存経路には適用されない（影響度: 中）

- **README の記述**: 「動作の流れ」5（L40）で「動画終了時、または終了 3 秒以内まで進んだ場合は終了扱いにします。自動削除が ON の場合は保存データを削除し、OFF の場合は最小保存時間を満たす終了位置を保存します」と記載している。
- **実装の根拠**: `END_THRESHOLD_SEC`（3 秒）の判定を行うのは `savePositionCore`（`content.js` L431、定期保存および一時停止時）のみである。`handleTimeUpdate`（L156-181）では終了 3 秒以内の判定を行わず `lastValidPosition` を更新し続けるため、終了 3 秒以内に入ってから `ended`・定期保存・一時停止のいずれも発生する前に別動画遷移・タブ非表示・ページ離脱が起きると、`saveForNavigation`（L519-543）は終了扱い（削除）にせずその位置をそのまま保存する。

### 2-4. 再起動後の復元先すり替え補正の適用範囲（影響度: 低〜中）

- **README の記述**: 「主な機能」（L18）で「Chrome の再起動後、プレイリストのタブが自動再生で進む前の動画に戻されたときは、最後に見ていた動画へ移動し直す」と記載している。
- **実装の根拠**: `background.js` の `isWatchUrl`（L252-255）および `advanceRestoreGuard`（L279-354）は `list=` パラメータの有無を条件にしておらず、未読み込み（`status === 'unloaded'`）で作成された `/watch?v=...` の復元タブ全般を対象とする（README L150 の `webNavigation` 権限説明のほうが実装の範囲に近い）。

### 2-5. `tabs` 権限の用途説明の不足（影響度: 低〜中）

- **README の記述**: 「使用している権限」（L148）では `tabs` 権限の用途を「ポップアップから同じ動画の既存 YouTube タブを探して切り替えるため」のみとしている。
- **実装の根拠**: ポップアップの既存タブ切替（`popup.js` L197, L210）に加え、`background.js` での既存 YouTube タブへの再注入（L28, L50, L73）、診断ログのタブイベント記録・起動時スナップショット取得（L164, L172, L177）、再起動後の復元先すり替え補正（L279, L289, L335）にも `tabs` API を使用している。

### 2-6. 「古い保存データを自動削除」の実行タイミング（影響度: 低）

- **README の記述**: 設定項目表（L109）で「ポップアップ起動時に古いデータを整理（30日・90日・180日）」としている。
- **実装の根拠**: ポップアップ起動時（`popup.js` L497）だけでなく、設定画面で日数を変更した直後にも即座に `cleanupExpiredVideos` が実行される（`popup.js` L454-458）。

### 2-7. 対象ページ判定の厳密さ（影響度: 低）

- **README の記述**: 注意事項（L176）で「YouTube の動画ページ（`https://www.youtube.com/watch?v=...`）でのみ動作します」としている。
- **実装の根拠**: `content.js` の `getVideoId`（L243-246）は `new URLSearchParams(window.location.search).get('v')` のみを参照しており、`pathname === '/watch'` の確認や動画 ID 形式の検証を行っていない（`manifest.json` L37 の注入対象は `https://www.youtube.com/*`）。一方、`background.js` の `isWatchUrl`（L252-255）は `path === '/watch'` を確認している。通常の YouTube 利用では `?v=` が付くのは `/watch` のため実務上の影響は軽微だが、実装上の厳密な条件とは差がある。

### 2-8. 英語版 README と英語 UI ラベルの表記ゆれ（影響度: 低）

- **拡張機能名**: `README.en.md`（L1）は `YouTube Playback Position Auto Save` だが、`_locales/en/messages.json`（L3）の `extName` は `YouTube Playback Position Saver` である。
- **設定項目名**: `README.en.md`（L99-110）と `_locales/en/messages.json`（L89-185）で以下の表記差がある。
  - `Show notification on restore` / 実際: `Show restore notification`
  - `Auto-play after restore` / 実際: `Autoplay after restore`
  - `Skip saving short watches` / 実際: `Ignore brief watches`
  - `Auto-delete watched videos` / 実際: `Auto-delete fully watched videos`
  - `Open videos` / 実際: `Open video behavior`

---

## 3. 実装と一致していることを確認した主な項目

以下については現行コードと照合し、README の記述に問題がないことを確認した。

- **主要な定数表（全 11 項目）**: 保存間隔（`5 / 10 / 30`、`shared.js` L23）および `VIDEO_CHECK_INTERVAL_MS`〜`POPSTATE_INIT_DELAY_MS`（`content.js` L31-43）の値はすべて一致。
- **既存 7 設定項目の既定値と選択肢**: `shared.js`（L11-25）および `popup.html`（L47-119）と一致。
- **基本動作・保護ロジック**: 広告再生中の保存抑止と広告終了後の復元再試行（`content.js` L158, L186, L413, L602-607）、`.ytp-live-badge` の可視状態による配信中ライブ判定（`content.js` L277-307）、動画終了後に終了 3 秒前より手前へシークした際の保存再開（`content.js` L213-221）、視聴完了時の最小保存時間適用（`content.js` L475）、動画長差 5 秒超での復元スキップ（`content.js` L615-619）はいずれも一致。
- **ポップアップの基本操作**: 新着順ソート（`popup.js` L147）、タイトル・動画 ID 検索（L296-306）、既存タブ優先／新規タブ切替（L186-219）、JSON エクスポート／インポート／動画データ一括削除（L333-350, L381-417, L464-474）は一致。
- **宣言済み権限リストとライセンス**: `manifest.json`（L7-15）の権限一覧（`storage`, `tabs`, `scripting`, `webNavigation`, `https://www.youtube.com/*`）および `LICENSE`（MIT License）は一致。

---

## 4. 対応結果（2026-11-25）

上記の差分調査を受け、以下を実施した。

1. **一時的な診断ログ機能のコード削除**:
   - `shared.js` から `DIAG_LOG_KEY`, `DIAG_LOG_MAX_ENTRIES`, `appendDiagEntry` を削除（`parseWatchUrl` は `background.js` の復元補正で使用するため維持）。
   - `background.js` から `diag_nav_log` の記録・起動スナップショット・診断用 `tabs`/`webNavigation` リスナーおよび `recordDiag` 呼び出しを削除し、再注入処理と再起動時の復元先すり替え補正（`restoreGuardTabs`）を維持。
   - `popup.html`, `popup.js`, `popup.css`, `_locales/ja/messages.json`, `_locales/en/messages.json` から診断ログ UI・操作処理・翻訳キーを削除。
   - `tests/shared.test.js` から診断ログ用テストを削除し、復元補正テストを `tests/background-restore-guard.test.js` として新設。旧テストファイル（`tests/background-diag.test.js`、`tests/browser-diag-smoke.cjs`）も削除し、`npm test` 全 53 件の成功を確認。
2. **README の修正**:
   - `README.md` および `README.en.md` を現行バージョン `1.10.3` と診断ログ除去後の実装に合わせて全面更新（バージョン統一、`chrome.storage.local` / `chrome.storage.session` とデータ構造、URL タイムスタンプスキップ、`document_start`・先行プリフェッチ・一時消音、終了 3 秒以内の適用範囲、復元スキップ時の削除経路、`tabs` / `webNavigation` 権限用途、ファイル構成、英語 UI ラベル整合）。

