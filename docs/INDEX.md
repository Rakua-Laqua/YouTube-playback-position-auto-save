# docs 目次

## フォルダ構成

```text
docs/
├── INDEX.md
├── 2026-11-25_readme-implementation-diff.md
├── navigation-diagnostics.md
├── navigation-diagnostics-smoke-2026-09-27.json
└── playlist-restore-investigation.md
```

## ドキュメント一覧

- [2026-11-25_readme-implementation-diff.md](2026-11-25_readme-implementation-diff.md) — `README.md` / `README.en.md` と現行実装コードの食い違いおよび一致確認の調査記録。
- [navigation-diagnostics.md](navigation-diagnostics.md) — `schemaVersion: 2` ナビゲーション診断ログの有効化手順、記録項目、読み方および検証結果。
- [navigation-diagnostics-smoke-2026-09-27.json](navigation-diagnostics-smoke-2026-09-27.json) — 2026-09-27 実施の実ブラウザ検証（`tests/browser-diag-smoke.cjs`）の実行結果 JSON。
- [playlist-restore-investigation.md](playlist-restore-investigation.md) — Chrome 再起動後にプレイリストが以前の動画へ戻る現象の観察記録、`background.js` 復元補正の設計と未解決課題。
