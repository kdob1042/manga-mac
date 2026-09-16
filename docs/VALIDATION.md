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

## 段階B — SDK候補検証中

開始main: `22eab32d5dd4b7aadd8e26e670ec8408d87354f2`（段階Aマージ後）。`rig-core = 0.42.0`のprovider機能だけを候補実装中。採用は依存閉包・契約試験・Macビルドの確認後とし、現時点でSDKの安全性や実APIの成功は主張しない。

第一候補genai 0.6.5（公式tag `660b752fa62b639311e9c89642cbd9ce90565eb7`）はOllamaのkeep_aliveを渡す経路がなく、要求外パラメータもadapterで落ちるため、この版の採用を見送った。代替rig-core 0.42.0（公式tagのcommit `d5a34986a1ad57f1e9c5984b82f8d7438ffc717e`、MIT）は、provider clientとカスタムHttpClientExtだけを使う。agent/RAG/memory/管理DB/常駐proxyは追加しない。

provider別HTTP本文と応答解析をJSとmain.rsから削除してSDKへ移す。Gemini/DeepSeek/customは既存のOpenAI互換endpointを保持。provider/modelを明示し、環境変数から接続を選ばない。OllamaはSDKの型に合わせて`keep_alive: "0"`で即時解放を要求する（数値0と同じ解放方針）。local endpointの選択だけで推論のローカル完結は保証せず、UIもOllama接続と表示する。

要求は用途・登録済み接続ID・request ID・prompt/schema/画像だけ。登録後のキーはRustメモリだけで保持。HTTP clientは承認済みURL一つへPOSTのみ、HTTPS/443・DNS全アドレス検証と固定・proxy/redirect拒否・要求24MiB/応答8MiB・timeoutを適用。ストリーム/任意multipartは拒否。SDK呼出中のtracing購読を止め、エラーに応答本文を返さない。中止は通信futureをdropし、同一request IDの再送を拒否する。送信済みの中止は課金取消を保証しない。

元のLLM JS契約7件はSDKを実行するRust fixtureへ移植し、Nodeには接続選択/登録要求の2件を残す。原文ID・人物ID・非選択RGBAの既存試験は維持。追加CIでCargo.lock・features・RustSec/OSVを収集し、正式採用前に固定lockfileとfmt結果をコミットして再実行する。実API・Ollama WAN遮断・実Macの操作はnot_run。
