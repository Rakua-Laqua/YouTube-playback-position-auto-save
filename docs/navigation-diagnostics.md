# プレイリスト復元のナビゲーション診断ログ

実装日: 2026-09-27。ログ形式: `schemaVersion: 2`。

この機能は、Chrome再起動後にプレイリストの以前の動画へ戻る現象について、URLの復元表示、文書の読み込み、履歴更新を区別するための記録を追加する。現象そのものを修正する処理ではない。原因がChrome、YouTube、別の拡張機能のどれかは、記録を採取して判断する。

## 有効化と確認

1. 必要な旧ログがあれば、先にポップアップの設定画面にある「診断ログ（一時的）」から書き出す。新しい形式でも保存上限は500件なので、古い記録は順に消える。
2. `chrome://extensions` を開き、「YouTube 再生位置自動保存」の再読み込みボタンを押す。追加した `webNavigation` 権限と、新しいService Workerを読み込ませる。
3. YouTubeページを開いて短い移動を行い、設定画面から診断ログをJSONに書き出す。
4. 新しい `diagnostic-start` の `schemaVersion` が2で、`navigationEvents` に下記の7イベントがあることを確認する。続く `webNavigation.onCommitted` や `webNavigation.onHistoryStateUpdated` が採れていることも確認する。

開始記録の `navigationEvents` が空なら、APIのリスナーは登録されていない。再読み込みした拡張機能の読み込み元と権限を確認する。開始記録が保存上限で消えた場合は、新しいイベントの `schemaVersion`、`workerId`、`workerStartedAt` から実装とWorkerの区切りを確認できる。

今回のコードは未リリースの変更で、manifestの拡張機能バージョンは `1.10.1` のままである。実装の反映確認には、バージョン表示だけでなく `schemaVersion: 2` と実際のイベントを使う。

症状が再発したら、追加の移動でログを流してしまう前に書き出す。終了方法、終了直前の動画、終了時刻、起動時に復元の確認画面が出たかも控える。ログの有無だけから、Chromeの終了方法は判断できない。

## 記録する範囲

`chrome.storage.local` の既存キー `diag_nav_log` に最大500件を保存する。旧形式の記録は変換・削除せず、同じ配列に追記する。動画の再生位置データとは別のキーで、書き出し・削除には既存のポップアップを使う。外部へのログ送信は追加していない。

webNavigationイベントは、URLが `https://www.youtube.com/` で始まり、`frameId=0` のものだけを記録する。iframe、他ホスト、HTTPのイベントは記録しない。対象外ホストを経由するリダイレクトの全経路は追えない。

tabsイベントと起動時の一覧は、`tab.url`、`tab.pendingUrl`、提供された `changeInfo.url` のいずれかがYouTubeを指す場合に記録する。このため、別サイトからYouTubeへの移動途中では、その別サイトの確定済みURLも同じレコードに含まれる。履歴全体を継続収集する機能ではない。

イベントが増えたぶん、旧版より早く500件に達する。上限はイベント数であり、動画数や保存日数を保証しない。

## URLと共通項目

### tabsイベントのURL

| 項目 | 内容 |
| --- | --- |
| `tabUrl` | APIが返した `tab.url` |
| `pendingUrl` | APIが返した `tab.pendingUrl` |
| `changeUrl` | 更新通知の `changeInfo.url`。タブ作成・一覧では `null` |
| `url` / `parsed` | 旧ログとの互換用の代表値と動画IDなどの解析結果 |
| `status` | 作成・一覧ではタブの状態、更新通知では `changeInfo.status` |
| `tabStatus` | 更新通知で受け取った `tab.status` |

未提供のURLは `null`、APIが返した空文字は `""` のまま保存する。`url` は `changeUrl → tabUrl → pendingUrl` の順で最初の空でない値を採る。確定済みか遷移待ちかの判断には、必ず分離した項目を使う。

Chromeの復元直後に#2のURLが見えていても、その起動で#2のページの読み込みが完了した証拠にはならない。`tabs.onUpdated` の `loading` だけで、文書全体の読み込みと同じ文書内の移動を区別することもできない。[Chrome tabs API](https://developer.chrome.com/docs/extensions/reference/api/tabs#type-Tab)

### すべての新規レコードに付く項目

| 項目 | 内容 |
| --- | --- |
| `schemaVersion` | このログ形式では2 |
| `extensionVersion` | 記録した拡張機能のmanifestバージョン |
| `workerId` | Service Workerの起動ごとに発行するUUID |
| `workerStartedAt` | そのWorkerで診断処理が初期化された時刻 |
| `sequence` | そのWorkerがログを受け付けた順の連番。1から始まる |
| `receivedAt` / `at` | ログ受付時のISO形式UTC時刻。`at` は互換用で同じ値 |

`sequence` はWorker再起動でリセットされるため、`workerId` と組にして読む。連番はストレージ書き込み前に割り当てる。書き込み失敗があれば同じWorker内に欠番が残りうるが、欠番がないことはログの完全性を保証しない。

Workerの起動とChromeプロファイルの起動は別である。`diagnostic-start` はWorkerごとに記録され、`browser-startup` は `runtime.onStartup` に応じた一覧である。後者は非同期に一覧を取得するため、イベント受付時の `snapshotRequestedAt` と、取得後のログ受付時刻を区別する。空の一覧もそのまま残す。

## webNavigationの項目と読み方

| `event` | 観測対象 |
| --- | --- |
| `webNavigation.onBeforeNavigate` | ナビゲーション開始 |
| `webNavigation.onCommitted` | 新しい文書へのナビゲーション確定 |
| `webNavigation.onDOMContentLoaded` | DOM構築の完了 |
| `webNavigation.onHistoryStateUpdated` | History APIによるURL更新 |
| `webNavigation.onReferenceFragmentUpdated` | URLフラグメントの更新 |
| `webNavigation.onCompleted` | 読み込み完了 |
| `webNavigation.onErrorOccurred` | ナビゲーション失敗 |

各行にはURLに加えて、APIが提供した `tabId`、`frameId`、`parentFrameId`、`processId`、`frameType`、`documentId`、`parentDocumentId`、`documentLifecycle`、`transitionType`、`transitionQualifiers`、`error` を保存する。イベントによって提供されない項目は `null` になる。`documentId` は開始時に未提供でも、確定後のイベントから比較できる場合がある。

APIの `timeStamp` は `navigationTimeStamp` として保存する。`receivedAt` とは時計の基準がずれる場合があるので、両者の差をそのまま通信遅延として扱わない。[Chrome webNavigation API](https://developer.chrome.com/docs/extensions/reference/api/webNavigation)

読み方の例は次のとおり。

- #2の確定後、同じ `documentId` で#1の `onHistoryStateUpdated` が来た場合は、その文書の履歴更新として追う。
- #1の新しい文書が確定した場合は、同じタブの開始・確定・完了または失敗の順を追う。
- `transitionQualifiers` に `server_redirect` があればHTTPによるリダイレクト、`client_redirect` があればJavaScriptやmeta refreshによる移動の手掛かりになる。
- 開始後に `onErrorOccurred` があれば、その失敗も含めて読む。直後の別ナビゲーションを一つの成功した読み込みとしてまとめない。

これらは遷移方式の手掛かりであり、YouTube本体と特定の拡張機能のどちらが実行したかを示すものではない。HTTPステータス・応答ヘッダー・リダイレクト先の全経路も、この実装では保存しない。`webRequest` の追加は、採れた記録から必要性を判断する。

## 実装と検証

変更箇所は `background.js` の診断処理と `manifest.json` の権限である。再生位置の保存・復元、コンテンツスクリプトの注入処理、500件の保存上限は変更していない。リスナーは非同期の初期化を待たずに登録する。書き込みは既存のPromiseチェーンで直列化し、一度失敗しても次の記録を処理する。

2026-09-27に次を確認した。

| 検証 | 結果 |
| --- | --- |
| `npm test` | 63件成功。診断ログの13件を含む |
| `npm run check` | 本体4ファイルの構文チェック成功 |
| 独立したChrome for Testing 148.0.7778.97 | 実APIで7リスナーの登録、HTTPリダイレクト、履歴更新、再読み込み、失敗、主フレームへの絞り込みを確認 |

実ブラウザの確認には、新しい一時プロファイルと自作HTMLを使った。CDP Fetchでリダイレクト後を含むリクエストを応答または失敗させ、検証用ホストの名前解決も遮断して、実サービスへ接続しない構成で検証した。結果と代表的なイベントは [ブラウザ検証結果](navigation-diagnostics-smoke-2026-09-27.json) に保存している。

これは拡張機能APIの結合確認であり、実際のYouTubeでの長時間再生・Chrome再起動による不具合の再現ではない。普段使いのChrome 153のプロファイルは再読み込みしていないため、利用開始には先頭の有効化手順が必要である。

### ブラウザ検証の再実行

`tests/browser-diag-smoke.cjs` は手動実行用で、通常の `npm test` には含めていない。既に用意されているPlaywrightモジュールと、拡張機能の読み込みに対応したChromiumまたはChrome for Testingを指定する。

```powershell
node tests/browser-diag-smoke.cjs "<Playwrightモジュールのパス>" "<テスト用Chromeの実行ファイル>" "<結果JSONの出力先>"
```

スクリプトは通常のプロファイルを受け付けず、毎回一時プロファイルを作る。ブラウザは終了時に閉じるが、一時プロファイルは調査用に残る。入力方法やpersistent contextの前提は [Playwrightの拡張機能テスト](https://playwright.dev/docs/chrome-extensions) に基づく。

### レビューで確認した点

Jevの編集後レビューは追加検証を示唆したため、任意項目の欠落、空の一覧、保存上限、Workerの再起動をコードとテストで確認した。理由の候補を比較した際には、新しい権限と実イベントの有効化確認が優先されたため、上記の実ブラウザ検証を追加した。

初回のブラウザ検証では、テスト側のルーティングで302の遷移先を処理できず、ページ読み込みがタイムアウトした。先頭URLだけがハンドラーに届くことを確認し、CDP Fetchによる各リクエストの処理に変更した後に成功した。この失敗を拡張機能の不具合とは判定していない。
