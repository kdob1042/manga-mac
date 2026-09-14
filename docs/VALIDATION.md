# 実装・検証記録

仕様は[設計書](IMPLEMENTATION_PLAN.md)。作業と残件は[Issue #5](https://github.com/kdob1042/manga-mac/issues/5)。

## 段階A — PR #6

開始main: `9391c7f50a021c774f808a725c44c4f8eea76cfa`。PR #4は文書のみで、再適用していない。

| 検証 | 結果 |
|---|---|
| Node契約・原文・領域保護・版試験 | 17件成功 |
| Vite build | 成功。既存の静的/動的import混在の警告あり |
| Chromium UI・再読込・Undo・PNG/CBZ | 3件成功（CI run 34824097915） |
| Rust保存・中断復旧・改竄検出 | 3件成功、clippy・fmt成功（同CI、Mac本体のtest・clippyも成功） |
| Mac package、DMG | 成功（CI run 34824097915、Apple Silicon unsigned DMG） |
| 実Mac導入・実画像AI・24GB性能・署名公証 | `not_run` |
| Blender、外部実API | 段階Aの対象外、`not_run` |

旧mainのMac失敗はSwift依存先の`MTLGPUFamily.apple10`とXcode 15.4の不整合（run 34820717876）。CI runnerをmacOS 26へ更新した。[GitHub公式runner案内](https://github.blog/changelog/2026-02-26-macos-26-is-now-generally-available-for-github-hosted-runners/)。これは実機動作の証明ではない。

保存は既存SQLite/WAL・SHA-256・base64を再利用。追加した`storage.rs`は作品画像の不変保存だけを担当し、3D/LLM/汎用画像処理を実装しない。DBの既存JSONを`project_backups`へ保存後、画像を一時ファイルへコピー・ハッシュ検証・同期し、上書きしない形で公開する。全参照の読戻し成功後にDBをトランザクション更新する。中断時の未参照ファイルは採用されず、再保存で同じhashを再利用できる。

バックアップはアプリ終了後に作品フォルダ全体（SQLiteと`artifacts`）を保存する。JSON書出しは画像を含む自己完結形式を維持する。旧アプリへ戻す場合は移行前のフォルダ全体を復元する。ファイル欠損・改竄時はエラーとし、最新作品を自動で過去版に置換しない。DB内の移行前JSONも保持するが、バックアップ復元UI・ファイルGCは未実装。

応答不明jobは再起動時に`unknown`とし、無断再実行を止める。候補の採否UIと未確定jobの解決導線は段階Eで実装する。原作と採用版は保持され、既存画像の閲覧・Undo・出力は可能。

最終追補：Undo前後が異なる画像のfixture、採用ポインタのhash不一致拒否、未確定jobの再実行拒否を追加。追補後のCI結果はPR #6へ記録する。Swiftビルドは同じcompilerとhelper入力に限ってキャッシュを再利用し、build・test・clippy・DMGのゲートは省略しない。

## 段階C — 実Blender接続候補、未検証

開始main: `22eab32d5dd4b7aadd8e26e670ec8408d87354f2`。BのSDK変更から独立してAのmainを起点にする。別PRのBを先にマージした場合、main.rs・Cargo・CI・検証文書の両方の差分を保持して更新する。

Blenderの既存CLIと内部Python API `bpy`を固定テンプレートから利用する。bpyは外部HTTP APIではない。外部MCPサーバー/追加常駐プロセスは使わず、アプリ専用子プロセスのstdinだけで型付き操作を渡す。任意Python/shellは受け付けない。既存MCPに追加する必要がある認可・job対応と同じ最小接続部分をRustで持ち、3D描画・camera・scene graphはBlenderを再利用する。

候補対応版はBlender 4.5.13（[公式tag](https://github.com/blender/blender/tree/daeeeca98fb0b6f0994b374d0069893186197a44)、GNU GPL）。配布binaryは公式download.blender.orgの同版とpublisher SHA-256をCIで照合する。まだダウンロード/実行・binary hash固定は完了していない。アプリへBlender本体を同梱せず、Macの既存インストールを指定する。

接続窓口、カメラ焦点距離変更、実値読戻し、PNG撮影、checkpoint保存、期待版/request ID、専用出力フォルダ、旧source非上書き、再起動時unknown化を実装候補に追加。プロセスの環境は必要項目だけ。Blenderの任意script自動実行・compositor/sequenceによる別出力を無効化する。カラー以外の補助パスは未対応。外部依存がある撮影はdependencies_pinned=falseであり、Dの原本パック完成とは扱わない。

ローカルnpm ci・Node 17件・Vite・Python構文確認は成功。実Blenderのcamera/render/save/reopenとRust IPC試験を追加したが、GitHub Actionsがrunner割当・最初のstepより前に終了するため未実行。Cの完了条件は未達。Rustコンパイル/fmt/clippy、UI画面、実Blender、Macは未検証。unknown要求の完了成果物を確認/採用する復旧導線も残件。新しい3Dデータが既存2Dコマへ入り、漫画になる経路はD/Eの残件である。
