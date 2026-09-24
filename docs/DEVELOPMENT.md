# 開発案内

## 変更箇所を探す

設計の正本は [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md)。この表はコードへの案内であり、別の仕様書ではない。関係する行から読み、設計書・検証履歴の全文を毎回読む必要はない。

| 責務 | 実装入口 | 設計書の節 |
| --- | --- | --- |
| 画面の接続・操作状態 | `src/main.jsx` | 3、8 |
| 接続・人物設定 | `src/SettingsPanel.jsx`、各Settings | 3、10 |
| 漫画の逐次制作工程 | `src/production.js`、`src/pipeline.js` | 5〜7 |
| 原稿の版・選択反映 | `src/source-*.js`、`src/story-library.js` | 4、6 |
| 原稿更新案のネーム・セクション完了 | `src/NameEditor.jsx`、`src/name-edit.js`、`src/section-completion.js` | 原稿からセクション完了まで |
| ネームAI・GitHub / JSON取込 | `src/NamePlanControls.jsx`、`src/name-repository.js`、`src/name-v2.js`、`contracts/name-plan/`、`tools/manga-director/validate.mjs`（診断のみ） | 23、[受渡し手順](NAME_PLAN_IMPORT.md) |
| モデル選択・生成境界 | `src/media.js`、`src/media-runtime.js`、`src/image-executor.js`、`src-tauri/src/media.rs` | 18 |
| レイヤー・Compositor | `src/compositor.js`、`src/layered.js`、`src/layer-edit.js`、`src-tauri/src/compositor.rs` | 18の関連節 |
| コマ・画像配置・文字 | `src/layout.js`、`src/layout-ai.js`、`src/render.js`、`src/PageProof.jsx`、`src/lettering.js`、`src/LetteringControls.jsx` | 8、16 |
| ページ出力・解像度確認 | `src/ExportControls.jsx`、`src/export.js`、`src/output.js` | 8 |
| 前後コマ・修正候補の比較 | `src/artwork-comparison.js`、`src/PanelContextComparison.jsx`、`src/CandidateComparison.jsx` | 8 |
| 採用・履歴・保存 | `src/revisions.js`、`src/project-writer.js`、`src/bridge.js`、`src-tauri/src/storage.rs` | 4、9 |
| 動画の編集・候補 | `src/VideoWorkspace.jsx`、`src/video*.js`、`src-tauri/src/local_video.rs`、`src-tauri/src/runway.rs` | 12 |
| 3D素材・Tripo | `src/tripo.js`、`src-tauri/src/scene_asset.rs`、`src-tauri/src/tripo.rs` | シーン素材、Tripo |
| 配信とプレビュー出力 | `src/live-export.js`、`src/live-preview.js` | Live Manga配信用出力 |
| バックアップ | `src/useBackupSchedule.js`、`src/BackupSettings.jsx`、`src-tauri/src/backup.rs` | 14 |

UIは操作を接続し、工程は既存Jobと保存経路を使う。ドメイン計算へReactやIPCを持ち込まない。3D編集はシーンデータとGLB素材を使う。新しい抽象層を作る前に既存責務へ配置できるか確認する。

## 設定の正本

| 設定 | 正本 |
| --- | --- |
| JS依存・実行コマンド | `package.json` / `package-lock.json` |
| native依存・release最適化 | `src-tauri/Cargo.toml` / `Cargo.lock` |
| アプリ識別子・CSP・配布物 | `src-tauri/tauri.conf.json` |
| CI変更分類 | `scripts/classify-ci.mjs` |
| CI実行とMac配布 | `.github/workflows/check.yml`（機能固有の検証は各workflow） |
| モデルID・対応入力・費用 | `src/media-registry.json`。JS/nativeで共用し、画面に別定義を持たない |
| 原稿契約 | `contracts/story-source/`、`contracts/story-library/` |
| Live配信契約 | live-mangaの `contracts/`。このrepoの `vendor/live-manga/` は同期スクリプトによる固定版であり手編集しない |

設定値を別のAI指示ファイルに転載しない。文書は次の役割に分け、手順や設定値を転載せずリンクする。

| 文書 | 読む場面・役割 |
| --- | --- |
| [README](../README.md) / [AGENTS](../AGENTS.md) | 利用者 / エージェントの入口と必須ルール |
| [USAGE](USAGE.md) | 日常操作。原稿取込みから完成まで |
| [INSTALL_MAC](INSTALL_MAC.md) | 導入・接続・更新・復元 |
| 本書 | 実装入口、設定の正本、開発・検証手順 |
| [IMPLEMENTATION_PLAN](IMPLEMENTATION_PLAN.md) | 確定仕様。変更領域の節を読む |
| [VALIDATION](VALIDATION.md) | 日付・SHA付きの試験履歴。現在の残確認はIssue #266 |
| [ISSUE_WORKFLOW](ISSUE_WORKFLOW.md) | 仕様確定と残件の切出し |
| [PROJECT_AUTOMATION](PROJECT_AUTOMATION.md) | 着手・状態同期・障害復旧 |

## ブランチと検証

- 最新dev → 作業ブランチ → dev向けPR。default branchがmainでも通常作業の起点はdev。main/devへ直接pushしない。
- 着手はIssueへ `/start`。自動作成したDraft PRを再利用する。状態・復旧は [PROJECT_AUTOMATION.md](PROJECT_AUTOMATION.md)、設計反映・部分完了は [ISSUE_WORKFLOW.md](ISSUE_WORKFLOW.md) が正本。
- PR/dev pushのLinuxチェックは変更分類に従う。共通Rust・依存・未知の変更は全系統。UI、Live配信連携、依存監査は該当変更で実行する。
- native/Tauri変更をdevへマージした後は `macOS validation`。失敗した版はmainへ昇格しない。検証済みのまとまりをdev → mainのPRで反映し、mainでは `macOS release package` が配布DMGを作る。
- 重大な配布不具合のみhotfix → main。main固有の修正は必要に応じ別PRでdevにも反映する。履歴だけを合わせるmain → dev同期はしない。
- 原稿repositoryのmainは読取り元であり、アプリ開発ブランチと混同しない。

Web: `npm ci` 後に `npm test`、`npm run build`、`npm run test:ui`。UI試験でChromiumが未導入なら `npx playwright install --with-deps chromium`。変更したnative領域は `tests/storage`、`tests/llm` の該当Cargo manifestで検証する。正確な実行オプションはCIに集約する。

Mac開発起動:

```sh
swift build -c release --package-path helper
mkdir -p src-tauri/binaries
cp helper/.build/release/manga-engine src-tauri/binaries/manga-engine-aarch64-apple-darwin
npm run tauri dev
```

## サイズ・性能を確認する

`npm run build` のentry JSと遅延chunkを別々に比較する。SettingsPanelは設定を開いた時、VideoWorkspaceは動画へ初めて切り替えた時、NamePlanControlsは制作範囲の詳細を初めて展開した時に読み込む。動画・ネームは非表示にしても入力状態を保持する。バックアップスケジュールは設定画面の開閉に依存させない。

Rust releaseはthin LTO・単一codegen unit・debug情報除去を使用する。panic方式や検証を弱めない。Mac配布サイズは同一toolchain/targetでDMGと実行ファイルを比較する。Webの初期JS削減をDMG全体や推論速度の改善率として報告しない。

文書、実装、共通テスト、Macビルド、実機画質・性能の結果を分けて報告する。実機では2人の参照、範囲外画素保持、再起動/Undo、オフライン、速度/メモリを確認し、詳細は [VALIDATION.md](VALIDATION.md) に残す。
