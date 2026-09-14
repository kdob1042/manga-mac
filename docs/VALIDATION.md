# 実装・検証記録

仕様は[設計書](IMPLEMENTATION_PLAN.md)。作業と残件は[Issue #5](https://github.com/kdob1042/manga-mac/issues/5)。

## 段階A — PR #6

開始main: `9391c7f50a021c774f808a725c44c4f8eea76cfa`。PR #4は文書のみで、再適用していない。

| 検証 | 結果 |
|---|---|
| Node契約・原文・領域保護・版試験 | 17件成功 |
| Vite build | 成功。既存の静的/動的import混在の警告あり |
| Chromium UI・再読込・Undo・PNG/CBZ | 3件成功（CI run 34823763907） |
| Rust保存・中断復旧・改竄検出 | 3件成功、clippy成功（同CI） |
| Mac package、DMG | 更新したmacOS 26 runnerで検証中 |
| 実Mac導入・実画像AI・24GB性能・署名公証 | `not_run` |
| Blender、外部実API | 段階Aの対象外、`not_run` |

旧mainのMac失敗はSwift依存先の`MTLGPUFamily.apple10`とXcode 15.4の不整合（run 34820717876）。CI runnerをmacOS 26へ更新した。[GitHub公式runner案内](https://github.blog/changelog/2026-02-26-macos-26-is-now-generally-available-for-github-hosted-runners/)。これは実機動作の証明ではない。

保存は既存SQLite/WAL・SHA-256・base64を再利用。追加した`storage.rs`は作品画像の不変保存だけを担当し、3D/LLM/汎用画像処理を実装しない。DBの既存JSONを`project_backups`へ保存後、画像を一時ファイルへコピー・ハッシュ検証・同期し、上書きしない形で公開する。全参照の読戻し成功後にDBをトランザクション更新する。中断時の未参照ファイルは採用されず、再保存で同じhashを再利用できる。

バックアップはアプリ終了後に作品フォルダ全体（SQLiteと`artifacts`）を保存する。JSON書出しは画像を含む自己完結形式を維持する。旧アプリへ戻す場合は移行前のフォルダ全体を復元する。ファイル欠損・改竄時はエラーとし、最新作品を自動で過去版に置換しない。DB内の移行前JSONも保持するが、バックアップ復元UI・ファイルGCは未実装。

応答不明jobは再起動時に`unknown`とし、無断再実行を止める。候補の採否UIと未確定jobの解決導線は段階Eで実装する。原作と採用版は保持され、既存画像の閲覧・Undo・出力は可能。
