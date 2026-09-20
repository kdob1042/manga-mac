# 開発案内

## 変更箇所を探す

設計の正本は [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md)。この表はコードへの案内であり、別の仕様書ではない。関係する行から読み、設計書・検証履歴の全文を毎回読む必要はない。

| 責務 | 実装入口 | 設計書の節 |
| --- | --- | --- |
| 画面の接続・操作状態 | `src/main.jsx` | 3、8 |
| 接続・人物設定 | `src/SettingsPanel.jsx`、各Settings | 3、10 |
| 漫画の逐次制作工程 | `src/production.js`、`src/pipeline.js` | 5〜7 |
| 原稿の版・選択反映 | `src/source-*.js`、`src/story-library.js` | 4 |
| コマ・画像配置・文字 | `src/layout.js`、`src/render.js`、`src/lettering.js` | 8、16 |
| 採用・履歴・保存 | `src/revisions.js`、`src/project-writer.js`、`src/bridge.js`、`src-tauri/src/storage.rs` | 4、9 |
| 動画の編集・候補 | `src/VideoWorkspace.jsx`、`src/video*.js` | 12 |
| Blender接続・Tripo | `src/live-blender.js`、`src/tripo.js`、`src-tauri/src/blender_live.rs`、`src-tauri/src/tripo.rs`、`blender/live/` | Live Blender、Tripo |
| 配信とプレビュー出力 | `src/live-export.js`、`src/live-preview.js` | Live Manga配信用出力 |
| バックアップ | `src/useBackupSchedule.js`、`src/BackupSettings.jsx`、`src-tauri/src/backup.rs` | 14 |

UIは操作を接続し、工程は既存Jobと保存経路を使う。ドメイン計算へReactやIPCを持ち込まない。Blender機能は既存API/MCP/アドオンを再利用する。新しい抽象層を作る前に既存責務へ配置できるか確認する。

## 設定の正本

| 設定 | 正本 |
| --- | --- |
| JS依存・実行コマンド | `package.json` / `package-lock.json` |
| native依存・release最適化 | `src-tauri/Cargo.toml` / `Cargo.lock` |
| アプリ識別子・CSP・配布物 | `src-tauri/tauri.conf.json` |
| CI変更分類 | `scripts/classify-ci.mjs` |
| CI実行とMac配布 | `.github/workflows/check.yml` |
| Live配信契約 | live-mangaの `contracts/`。このrepoの `vendor/live-manga/` は同期スクリプトによる固定版であり手編集しない |

設定値を別のAI指示ファイルに転載しない。READMEは入口、USAGEは操作、INSTALL_MACは導入、設計書は仕様、VALIDATIONは検証履歴を担当する。

## ブランチと検証

- 最新dev → 作業ブランチ → dev向けPR。default branchがmainでも通常作業の起点はdev。main/devへ直接pushしない。
- 着手はIssueへ `/start`。自動作成したDraft PRを再利用する。状態・復旧は [PROJECT_AUTOMATION.md](PROJECT_AUTOMATION.md)、設計反映・部分完了は [ISSUE_WORKFLOW.md](ISSUE_WORKFLOW.md) が正本。
- PR/dev pushのLinuxチェックは変更分類に従う。共通Rust・依存・未知の変更は全系統。UI、Live連携、実Blender、依存監査は該当変更で実行する。
- native/Tauri変更をdevへマージした後は `macOS validation`。失敗した版はmainへ昇格しない。検証済みのまとまりをdev → mainのPRで反映し、mainでは `macOS release package` が配布DMGを作る。
- 重大な配布不具合のみhotfix → main。main固有の修正は必要に応じ別PRでdevにも反映する。履歴だけを合わせるmain → dev同期はしない。
- 原稿repositoryのmainは読取り元であり、アプリ開発ブランチと混同しない。

Web: `npm test`、`npm run build`、`npm run test:ui`。変更したnative領域は `tests/storage`、`tests/llm`、`tests/blender` の該当Cargo manifestで検証する。正確な実行オプションはCIに集約する。

Mac開発起動:

```sh
swift build -c release --package-path helper
mkdir -p src-tauri/binaries
cp helper/.build/release/manga-engine src-tauri/binaries/manga-engine-aarch64-apple-darwin
npm run tauri dev
```

## サイズ・性能を確認する

`npm run build` のentry JSと遅延chunkを別々に比較する。SettingsPanelは設定を開いた時、VideoWorkspaceは動画へ初めて切り替えた時に読み込み、その後は接続・編集中の状態を保持する。バックアップスケジュールは設定画面の開閉に依存させない。

Rust releaseはthin LTO・単一codegen unit・debug情報除去を使用する。panic方式や検証を弱めない。Mac配布サイズは同一toolchain/targetでDMGと実行ファイルを比較する。Webの初期JS削減をDMG全体や推論速度の改善率として報告しない。

文書、実装、共通テスト、Macビルド、実Blender、実機画質・性能の結果を分けて報告する。実機では2人の参照、範囲外画素保持、再起動/Undo、オフライン、速度/メモリを確認し、詳細は [VALIDATION.md](VALIDATION.md) に残す。
