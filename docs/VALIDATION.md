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

## 段階C — 実Blender接続候補、未検証

開始main: `22eab32d5dd4b7aadd8e26e670ec8408d87354f2`。BのSDK変更から独立してAのmainを起点にする。別PRのBを先にマージした場合、main.rs・Cargo・CI・検証文書の両方の差分を保持して更新する。

Blenderの既存CLIと内部Python API `bpy`を固定テンプレートから利用する。bpyは外部HTTP APIではない。外部MCPサーバー/追加常駐プロセスは使わず、アプリ専用子プロセスのstdinだけで型付き操作を渡す。任意Python/shellは受け付けない。既存MCPに追加する必要がある認可・job対応と同じ最小接続部分をRustで持ち、3D描画・camera・scene graphはBlenderを再利用する。

候補対応版はBlender 4.5.13（[公式tag](https://github.com/blender/blender/tree/daeeeca98fb0b6f0994b374d0069893186197a44)、GNU GPL）。配布binaryは公式download.blender.orgの同版とpublisher SHA-256をCIで照合する。まだダウンロード/実行・binary hash固定は完了していない。アプリへBlender本体を同梱せず、Macの既存インストールを指定する。

接続窓口、カメラ焦点距離変更、実値読戻し、PNG撮影、checkpoint保存、期待版/request ID、専用出力フォルダ、旧source非上書き、再起動時unknown化を実装候補に追加。プロセスの環境は必要項目だけ。Blenderの任意script自動実行・compositor/sequenceによる別出力を無効化する。カラー以外の補助パスは未対応。外部依存がある撮影はdependencies_pinned=falseであり、Dの原本パック完成とは扱わない。

ローカルnpm ci・Node 17件・Vite・Python構文確認は成功。実Blenderのcamera/render/save/reopenとRust IPC試験を追加したが、GitHub Actionsがrunner割当・最初のstepより前に終了するため未実行。Cの完了条件は未達。Rustコンパイル/fmt/clippy、UI画面、実Blender、Macは未検証。unknown要求の復旧導線は下記追補で追加したが、実行検証は残件。新しい3Dデータが既存2Dコマへ入り、漫画になる経路はD/Eの残件である。

## 段階C追補 — 未確定要求の復旧（2026-09-15）

既存のBlender要求台帳・成果物検証・SQLiteトランザクションを再利用し、未確定要求を「保存結果を検証して採用」「採用せずに解消」できるようにした。どちらもBlenderを起動しない。採用は要求のsession ID・要求ID・現在版・要求開始版を照合し、成果物hashを検証・同期してから採用版と要求状態を同じトランザクションで更新する。旧版・破損・処理中・解消済みの要求は採用を拒否する。解消時も現在の採用版と成果物ファイルを保持し、プロセス取消済みとは表示しない。

UIは未確定要求がある間の新規撮影を無効化し、失敗後に状態を再取得する。状態一覧では未解決要求を優先して表示する。新しい依存関係・作品スキーマ・Blenderエンジンは追加していない。

追加試験：
- Rust人工ファイル試験3件：中断後の一度だけの採用、破損・対象違い・ID/版不一致の拒否と非採用解消、旧開始版からの採用拒否。人工blendはファイル整合性検査専用で、実Blenderが開ける証拠ではない。
- Playwright 2経路：採用／非採用解消後に撮影が可能になり、復旧操作からblender_executeを呼ばないこと。
- UIテストファイルのJavaScript構文解析のみ、利用可能なV8環境で成功。Playwright・React描画・Rustの実行を意味しない。

### 未検証ToDo

**別エージェントの着手手順・対象PR・コマンド・合格条件は[Issue #5の再開手順](https://github.com/kdob1042/manga-mac/issues/5#issuecomment-5676739718)を参照。** Mac不要の共通/Rust/実Blenderと、実機/資格情報待ちを分けている。下記は概要であり、進捗更新先はIssueのタスクIDとする。

ユーザー指示により、実行できない試験は未完として残し、独立して実装できる作業は継続する。

- [ ] 共通：npm ci / npm test / npm run build / npm run test:ui。GitHub Actionsの開始前失敗を解消後、最新headで実行
- [ ] Rust：Cargo.lock生成・差分確認・固定、fmt / clippy / test。追加recovery_testsを含む
- [ ] Blender：既存の実Blender撮影・保存・再読込試験と、実成果物を用いる復旧試験
- [ ] UI：復旧ボタン2経路のPlaywright実行・スクリーンショット確認
- [ ] Mac到着後：Tauri実IPC・撮影・終了/再起動・復旧・導入/更新/バックアップ
- [ ] Mac到着後：画像AIの実入力・品質、24GBピークメモリと処理時間
- [ ] 配布：macOSビルドとDMG。署名・公証は資格情報が利用可能になってから別判定

実装済み候補と合格確認済みは区別する。チェックを削除せず、実行していない試験にpassを付けない。Cの実Blender受入・D/Eの漫画制作経路は未完。

## 段階C追補 — 再起動後の撮影プレビュー

再起動/状態照会/復旧採用後に撮影previewが返らない不具合を修正。保存manifest・checkpoint/画像hashを検証してpreviewを復元する。サイズ上限・通常ファイル・PNG署名を採用前に確認し、破損を黙って表示しない。PNGの完全なデコード試験とは区別する。復旧後と再読込後のpreview一致、改変拒否のRust試験を追加（recovery_testsは計4件）。Rust/実画像/UIの実行はnot_run。変更コミットはPR #8を参照。

## 2026-09-16 main統合

ユーザーのmain統合指示に従い、PR #7のLLMとPR #8のBlenderの変更を統合。設定UI、IPC登録、依存、CIのllm/blender両ジョブとMacの依存ゲートを保持した。Node共通テスト12件をLinux上で再実行し全件pass。Rust toolchainはこの実行環境に無く、Rust compile/fmt/clippy、SDK監査とlockfile、Playwright、実Blender、Mac実機はnot_runのまま。マージはB/Cの受入完了を意味しない。残件は上記の引継ぎToDo（Issue #5 comment 5676739718）を継続し、D–HとIssue #9も未完了。

## 段階D-1 — コマ別ショットと固定撮影パック（2026-09-16）

Issue #5 Dの差分実装。Blenderが開いたblend内のasset_data（Object/Collection/Action・catalog ID・tags）とScene/Camera/Object一覧を読み出す。アプリに素材登録DBや3D描画を追加しない。Asset Browserで素材を組み合わせて保存したblendを既存接続画面から開く。全ライブラリ横断検索・未配置素材のアプリ内追加は未実装。

1〜4コマへ、同じ検証済み不変checkpointを参照する独立セッションを割り当てる。操作時は別Blenderプロセスから新jobフォルダへ保存するため他コマのObject/Actionや元素材を書き換えない。操作は既存Scene/Camera/frame選択・焦点距離・撮影。任意のボーン編集やポーズライブラリの適用UIは未実装（既存Blenderで準備したframeを選択）。CharacterBindingは人物ID→ショット内Object参照だけを保持。

Blender標準pack_all/pack_librariesで依存を格納し、保存したblendを再読込して未固定依存を検出する。未対応の動画/UDIM/volume/シミュレーション/Geometry Nodes等は拒否。採用した画像とcheckpointのhash・Scene/Camera/frame・解像度/色管理・カメラ行列・Cycles seed/sample数を撮影版へ記録。GPU差での画素一致や全Blender機能対応は保証しない。撮影履歴を読み直すIPCはDB記録とファイルhashを照合する。

確認済み: npm ci、Node 19件、npm run build、Python構文。lint/typecheckの独立スクリプトはない。ブラウザ接続自体は成功したが開発画面127.0.0.1はERR_BLOCKED_BY_CLIENT。Rust/Blender未配置、公式配布先の取得はタイムアウト。UI・Rust・実Blenderはnot_run。判定はD全体完了ではなくD-1候補。

次のエージェント向け残件（実行環境が揃い次第）:

- D-RUST: `cargo generate-lockfile --manifest-path tests/blender/Cargo.toml` → lockをレビュー・保存 → `cargo test --locked --manifest-path tests/blender/Cargo.toml --lib`。4ショット/重複ID rollback/tamper拒否の追加試験を含む。続けてclippyとappのcargo fmt/check。既存Bのlock/監査ToDoも残る。
- D-REAL: 公式Blender 4.5.13のSHA確認後 `python3 blender/test_real.py "$BLENDER_BIN" "$BLENDER_FIXTURES"`。追加試験は4ショット分離・素材metadata・外部texture削除後の旧版再読込。`acceptance-d.json`を保存。リンクライブラリの入れ子/リンク元texture/pose Action共有の実fixtureを追加してVERSION/SCOPEを確認する。失敗時は対応不可として拒否し、pinned判定を緩めない。
- D-UI: `npm run test:ui`に加え、4コマ割当→構図変更→撮影→旧原稿保持→再起動→保存済み撮影接続を実機で確認。割当結果の保存に失敗したら「保存済みショットを復元」、撮影結果の作品保存に失敗したら「保存済み撮影をこのコマへ接続」。再実行で同じjobを送らない。
- D-ASSET: 正本§4/8、Issue #5 Dに従い既存Asset Library横断取得・選択とpose適用を追加。分類の正本はBlender。現在の窓口は開いたblendだけなのでREUSE-01全体はnot_run/未完。
- BACKUP-3D: 3D履歴は`blender/`＋SQLiteを含む作品フォルダ全体で保管する。JSON書出しは画像とbinding情報のみでblendを含まない。作品フォルダ復元を実機で検証する。


### D-2追補：既存Asset Libraryの検索・取込

認可フォルダのblendをBlender `bpy.data.libraries.load(assets_only=True)`で読み、Blenderに登録済みのObject/Collectionだけ一覧化する窓口を追加。UIは名前・ファイルで絞込み、選択したソースhashが一致する場合だけ標準appendで舞台へ取り込む。検索キャッシュは保存しない。再検索で素材の追加/削除/改名を反映する。分類の追加DBは作らず、取込後のcatalog ID/tagsはBlenderのasset_dataから読む。大きなフォルダは256 blend/2000 assetを上限に明示拒否する。Collectionによるリグごとの取込を推奨。未対応依存は従来どおり保存前に拒否。

`blender/test_real.py`に検索→再検索→hash指定取込・古いhash/パス逸脱拒否の実fixtureを追加（not_run）。D-ASSETの横断取得・選択UIは実装候補ありへ更新。任意pose適用UI、入れ子リンク、再起動含む実Blender受入は未検証。Python構文とWeb buildはpass。

参考: Blender公式 [BlendDataLibraries](https://docs.blender.org/api/current/bpy.types.BlendDataLibraries.html)、[File operators](https://docs.blender.org/api/current/bpy.ops.file.html)。固定対応版4.5.13での実行を受入ゲートとし、current文書の存在だけで動作確認済みとしない。


## 段階E — 撮影原本から漫画化・候補採用（2026-09-16）

`blender_capture`で不変撮影画像を再読込・hash照合し、既存Swiftのoriginal入力へ画像bytesを渡す。人物参照に加え任意の画風参照を設定画面から登録できる。再撮影では旧原稿を参照に付け、2D修正意図を引き継ぐ。旧作画があれば新画像は候補のまま保持し、明示採用とUndoを行う。古い原作/コマ/参照/画風の基準版候補は拒否。未確定要求は確認して解決でき、同じ基準版の試行上限3回は再起動/取下げでリセットしない。

出力寸法は256〜1024・64の倍数へ制限し、撮影画像は縦横比を保って余白で合わせる。変換矩形を記録し、Swiftの出力寸法を照合する。ページ出力もcontainで描画する。画像AIの構造保持は品質保証ではない。顔推定は完成画像上の候補矩形を先に表示し、次の修正操作で確定。マスク外は既存RGBA合成で保護する。

「カメラを寄る/引く/焦点距離N mm」は対象ショット変更→撮影→対象だけ漫画化。他のポーズ/配置はBlenderでの調整を明示案内し、2D編集へ黙って流さない。吹き出し指示も画像AIへ流さない。任意の自然言語から全Blender操作を解決する機能ではない。

検証: Node24件/Web build。入力画像bytes・hash・参照順、padding計算、振分け、候補採用/古い基準拒否/Undo、試行上限維持の機械試験を追加。Swift upstream固定commitのCLIでwidth/heightのInt型・64倍数制約を確認。Rust/Swiftビルド、UI・実画像モデル・実Macはnot_run。

- E-MODEL: Macで`npm run tauri build`、人工4コマの撮影→漫画化、人物/画風/旧表情参照を実入力監査。GPUメモリ・画像寸法・キャラ一致を計測し、画像品質を別判定する。
- E-UI: 顔検出→矩形確認→局所編集→マスク外RGBA比較、カメラ寄り→候補比較→採用→Undo→再起動。候補が旧原稿を自動上書きしないことを確認。クラウドブラウザからlocalhost接続不可のためnot_run。
- E-RECOVERY: ローカル画像エンジン応答と作品保存の間の強制終了ではjobはunknownとなる。元原稿は保持し、採用せず解決するまで新要求を送らない。画像出力のエンジン側永続化/再取得は残件（現時点は完了応答がUIへ届くまで画像を再取得できない）。


E統合追補: PR #13のUI翻訳撤回・成果物英訳を保持して統合。統合確認でschema 3をRust保存が拒否する不整合を発見し、1/2/3を受け入れる修正とnative往復試験を追加（Rust試験not_run）。英訳unit ID重複の読込拒否も修正。追加後Node27件/Web build pass。PR #13由来の作品言語・字幕共有を撮影/作画変更で消さない。

## 段階H-1 — 組版とページ確認

既存Canvas/OSフォントの描画を拡張し、原文unit IDに対応した文字枠・位置・大きさを設定できるようにした。Intl.Segmenterで書記素を分割し、日本語の括弧・句読点の基本禁則を扱う。原文/英訳と段落順は固定し、文字枠の変更は画像AI/Blenderを呼ばない。PNG/CBZと同じpagePNGでページ確認するため別組版レンダラーは増やさない。画像はcontain。文字が入らなければ縮小下限でエラーにして本文を切捨てない。縦書き・ルビ・高度な組版は未対応。

Node29件/Web build pass。COST-01の文字配置でjob/原作/作画が不変、Undo可能を機械試験。Rust/Swift/実UI/実機品質はnot_run。重いBlender/Swift画像処理は共通ロックへ変更（同時起動しない）；24GB性能保証ではない。Mac導入ガイドへ候補実装の試用・バックアップ・復旧手順を追記。

H-REAL: 対象mainのmacOS CI/DMGを確認後、12コマ比較（正本§11）、画面/出力の日本語禁則・英訳・文字枠・キャラ一致、ピークメモリ、操作/待ち時間、更新/復元を記録する。コード署名と公証は所有者の鍵・アカウントが必要でnot_run。UI screenshot・実画像・ログを添付してからHを完了にする。

## Issue #9 V-A — 動画の共通参照とschema 4

`src/video.js`は原作範囲/順序・既存人物ID・開始画像不変版を検証し、既存作画画像と既存blender_captureの画像を同じmanifestへ解決する。出所とAPI実入力を分離。開始画像・参照版・基準採用版を複製登録せず参照し、未知の入力・能力・モデルを拒否する。jobsは既存配列へscope=videoShotで追加。外部通信/UIはこの段階では追加していない。

実行済み: `npm test` 33件pass、`npm run build` pass。MV-01のv1/v2/v3→v4のJSON実ファイル往復・冪等移行・再起動unknown、MV-02の作画/撮影共通解決、MV-03のmanifest/実bytes hash（HTTP送信はまだ未実装）、MV-04の非対応入力拒否、MV-05の基準変更検出、試行上限の維持を人工fixtureで確認。Mac SQLite往復試験をstorage.rsに追加したがRustが未配置のためnot_run。動画AI・再生・書出しの成功を示す試験ではない。

他エージェント向けの次の作業:

- V-A-NATIVE: `cargo test --manifest-path src-tauri/Cargo.toml storage::tests`、fmt/clippy/lockをMac等の適合環境で実行。schema 4の保存→終了→再開と旧作品PNG/CBZを確認。バックアップはSQLite/artifacts/blenderを含むフォルダ全体。旧appへ戻す場合は移行前フォルダへ戻し、番号だけ戻さない。
- V-B: storage.rs既存不変保存へサイズ制限付きMP4ストリーム保存・hash/MIME検証を追加。JSへ全量base64を渡さず、限定された再生経路とMP4書出しを作る。人工短編動画でMV-07/08/09を実行。採用/UndoはvideoHistoryのみ。旧結果/停止後結果は候補のまま保持。
- V-C: 正本§12の固定公式契約からRunway REST接続を実装。既存Rust資格情報/HTTP許可境界を再利用。POST前の永続job、応答task IDの即時保存、unknown非再POST、照会/取消/取得、予算を検証。HTTP fixtureと有料実APIを分ける。テストキー・予算は未提供なので有料実APIはnot_run。
- V-D: resolveStartImageのloadCaptureへ既存blender_captureを接続。動画専用カメラ/frameからの撮影も同じBlenderセッション処理を利用する。二人/一場所の実Blender fixtureでMV-11、Mac再生と24GB計測は実環境待ち。

Issue #5の残件: Dポーズ適用、E-RECOVERY、F既存Tripo拡張の安全な接続、G任意外部画像API、H実機受入。Tripo公式拡張の未認証汎用MCPをそのまま有効化しない。既存Blenderに取り込んだ素材はDのAsset Library経由で再利用できるが、生成サービス連携の完了とはしない。Issue #5/#9はopenを維持する。

## Issue #9 V-B — 動画保存・候補・Undoの実装候補

storage.rsを拡張し128MiB上限・64KiB単位stream・MP4 top-level box境界・SHA-256・no-clobber保存・書出し再照合を追加。MP4の完全decodeはOSプレイヤーに委ね、境界確認だけで再生可能とは断定しない。動画参照を追加する作品保存時は実ファイルを検証し、欠損/破損でDB採用を進めない。読込時は動画の欠損だけで漫画全体を読めなくせず、当該動画の再生・採用・書出しで拒否する。

JSは既存jobsに対応する動画候補の収集→明示採用→動画専用Undoを追加。初回も候補扱い。古い入力・原作・基準版では採用不可。漫画のpanels/historyを変更しない。UIは漫画/動画切替、同じ原作・開始画像からショット保存、保存済み動画の再生/採用/Undo/MP4書出し。外部APIの未実装を明示し、未接続の生成ボタンは表示しない。

実行済み: Node34件pass、Web build pass、diff check pass。FFmpegで人工1秒H.264動画を作成しffprobeで32×32/無音/1秒/1838 bytesを確認。fixtureはtests/fixtures/video-blue.mp4.base64。Rustテストには実ファイル往復/再起動/export hash/中断/不正hash/切詰め/128MiB上限/旧DB保持を追加したが、Rust環境なしでnot_run。Playwrightに共有画像→ショット保存→再起動→漫画保持の試験を追加、実行はnot_run。Tauri asset protocol/APIは公式文書で確認、Mac実再生は未検証。

次の実行項目:

- V-B-NATIVE: `cargo test --locked --manifest-path tests/storage/Cargo.toml` → clippy、app fmt/build。Macで保存済み候補の再生→採用→再起動→Undo→MP4書出しを行い、書出しhash一致を確認する。asset scopeが初期空、検証済み1ファイルだけ許可されることを確認。欠損動画の修復はバックアップからmediaファイルを復元する。
- V-B-UI: `npm run test:ui`でtests/ui/video.spec.jsと既存漫画回帰。実画面の再生・seek・エラーを確認しscreenshotを保存。Web build合格をUI受入に代用しない。
- V-Cは引き続き未実装。put_videoへのprovider出力stream接続、task ID永続化、キー/予算/送信許可、HTTP fixtureを実装後、V-Bと通しで確認する。API生成成功と動画採用を分ける。

## Issue #9 V-C — Runway接続の実装候補（2026-09-16）

上記V-C未実装の記録を更新。runway.rsに公式image_to_video POST、task GET/DELETE、出力取得を追加。既存Connectionsに用途を分けたメモリ限定キーを置き、PolicyTransportのDNS/private-address/no-proxy/no-redirect境界を利用する。作品の既存jobs.remoteへPOST前unknown/予約費用→task ID→状態→検証済みartifactを保存。古いUIでtask ID/費用/送信入力を消せないようstorage.saveを補強。別ジョブ台帳は追加しない。

画面は初期未設定のRunway接続/予算/送信許可、動きの案（既存演出LLM）/手入力、生成、手動照会、取得、取消を接続。APIのDELETEが完了taskの削除も行うため、その影響を確認した場合にだけ呼ぶ。キー未設定で送信しない。媒体切替では登録接続を保持し、明示解除/終了で破棄する。取得後にUIが落ちてもnativeのartifactから候補を復元・保存してから再生できる。新規POSTは復旧処理から呼ばない。

公式入力仕様の再確認で、5MBはdecode後でなくData URI全体の上限と判明し修正。また比率違いの自動中央cropを避けるため、現段階はPNG・8192px以下・縦横比0.5〜2・出力ratioと一致する画像だけを送信する。余白画像の自動生成/任意比率/JPEG-WebP入力は後続。v4の旧動画ショットは保持し、比率が合わない場合は画面で変更してから生成する。

実行済み: `npm test` **40件pass**、`npm run build` pass、`git diff --check` pass。追加検証は原文範囲/人物ID維持、再起動時task状態復元、取得済み候補の一度だけの接続、停止後候補保持、encoded上限/比率不一致の拒否、空作品の共通配列初期化。空作品で動画画面を開く際のartworks未初期化も修正した。

Rustに公式POST/header/実画像bytesを受けるローカルHTTP fixture、予約前予算拒否、永続送信マーカーによる再POST拒否、CDN/資格情報付きURL拒否、応答の署名URL除去、古いUI保存からtask/costを保護するSQLite試験を追加。これらは**Rustがないためnot_run**。tests/llmは既存appと同じrusqlite/sha2を追加しstorage/runwayを読み込む。lock/fmt/clippy/compileは未検証。PlaywrightはChromium不足でlaunch前に停止する既知状態、Mac/WebView/実API/実Blender/24GBもnot_run。今回、有料API要求は0回。

残件・次のエージェント向け:

- V-C-NATIVE: `cargo generate-lockfile --manifest-path tests/llm/Cargo.toml`→lock/依存差分をレビュー・保存→`cargo test --locked --manifest-path tests/llm/Cargo.toml`とclippy。`cargo test --locked --manifest-path tests/storage/Cargo.toml`、app fmt/clippy/buildも実行。既存の安全境界試験を削除しない。
- V-C-HTTP: 現在のHTTP fixtureはPOST/header/bodyとJSON応答、永続状態は別DB fixture。実アダプタ全体のGET/DELETE/CDN streamingを差し替えtransportで通す追加試験、redirect/private DNS/レスポンス中断/期限切れ/予約費用超過の通し試験が残る。鍵と署名URLがログ/作品JSONへ出ないことを監査する。
- V-C-UI/REAL: Native試験後、専用テストキーと明示予算内でPNG→5秒生成→手動照会→取得→Mac再生→採用→再起動→Undo→MP4 hash一致を実施。キー未提供なので有料実APIは未実施。公式例のCDN一ホスト以外は拒否するため、実際の応答ホストが違えば公式根拠・明示許可・安全境界テストを揃えて拡張する。無制限cloudfront wildcardにしない。
- V-C-RECOVERY: 取消応答を失いtaskも削除済みなら照会は失敗し得る。サービス側で確認する導線と、二重課金せず明示的に未確定状態を解決する操作を追加検証する。ダウンロード中の強制終了で残る`.video-download-*`は未採用の一時ファイル。参照/実行中のものを消さない回収方針は残件。
- V-D: 既存固定撮影→API実入力の橋渡しは追加済み。漫画コマ不要の動画専用Scene/Camera/frame撮影UI、共有素材新版の影響先表示、MV-11実Blender受入は残件。Issue #5のDポーズ/F/G/H/E-RECOVERYも継続。

V-Cは実装候補であり、有料生成・安全境界の受入完了やIssue #9完了とは扱わない。


## V-D1: 漫画コマなしの動画撮影導線（2026-09-16）

- 実装: 既存shot_batches/ShotControls/blender_fork/recordCaptureを媒体別scopeへ拡張。動画用の撮影準備→Scene/Camera/frame→撮影→開始画像選択が可能。漫画panels/historyを生成・変更せず、再撮影は旧開始画像と動画を保持する。
- ローカル: `npm ci`、`npm test`（42件）、`npm run build`、`git diff --check` 成功。
- `tests/ui/video-capture.spec.js` はテスト内だけでIPCを模擬し、空のpanelsから保存・撮影寸法・原作/人物対応・再読込を確認する。実Blender動作の証明ではない。ローカルChromium取得はtimeout/502、UI実行結果はPRのCIを参照。
- 実Blender/Mac受入: 素材を開く→漫画を作らず動画画面で専用撮影を準備→構図変更/960角撮影→開始画像へ選択→保存→再起動。同じ素材の漫画4コマと別動画ショットのカメラ・frame・旧撮影hashが変わらないことを確認する。新撮影の採用前に旧開始画像/動画が維持されること。実API呼出しは専用キー/予算がある場合のみ。
- 追加: 旧撮影の直接利用・作画経由・採用動画のJob経由の使用箇所を表示。同一base_sessionの保存版差を可視化し、形状変更の検出と混同しない。別接続での素材再登録の同一性は推定しない。
- 残件: 実BlenderによるMV-11証跡、24GB品質/性能。既存PR #20のCI修正と重複しない変更。

## V-C2: 手動解決・取得HTTP回帰（2026-09-16）

- 取消応答消失/404/期限切れ等は、サービス側の確認を明示してローカルで採用せず解決できる。これはリモート取消確定ではない。task ID・予約/実績費用・旧採用版は保持し、生成の自動再POSTはない。保存済み成果物がある要求には適用しない。
- 既存Runway adapterの出力要求生成とresponse→一時ファイル→不変保存→SQLite記録をprivate helperへ分離して同じ本番処理をHTTP fixtureで通す。テスト用localhost clientはcfg(test)内部だけ。本番のHTTPSホスト/DNS/redirect規則は変更しない。
- `CARGO_BUILD_JOBS=1 CARGO_PROFILE_DEV_DEBUG=0 cargo test --locked --manifest-path tests/llm/Cargo.toml`: **23 passed**。POST/GET/DELETEヘッダー、CDNへのキー非送信、404/不正JSON/MIME/サイズ超過/切断/期限切れ/不正MP4、成功の保存と再起動を確認。実Runway/実CDN/TLS経路の成功や動画品質の証明ではない。
- ローカルRust 1.98.1が利用可能になったため試験を実行。最初の並列debugビルドはarchive mmap errorで失敗し、jobs=1/debug=0で成功。tests/llm/Cargo.lockを固定。cargo auditはこのテスト依存閉包に対し脆弱性0・警告0。OSVも同じ190依存を確認し指摘0（2026-09-16）。アプリ全体の監査/ビルドはPR #20とmain CIの結果を別途確認する。
- clippyは基点mainの3警告（policy_transportのmanual_async_fn 2件、storageのmanual_range_patterns 1件）で失敗。PR #20の修正後に再実行する。Runway追加コードの警告とは分ける。
- Node **43 passed**、build/diff check成功。追加UI `tests/ui/video-recovery.spec.js` の結果はPR CIを参照。ローカルChromium downloadはtimeout/502で失敗。
- なお、プロセス強制終了で残った孤立一時ファイルの自動整理、実APIの予算/料金照合、Mac内再生・実機品質は残件。起動時の無条件削除で別プロセスの取得を壊す処理は追加していない。

### 依存固定の追加

- PR #20の整形ゲートを復元したhead `bc0458d11e1025eff65461f2aa1b91c402845cbe` に対するCI run `35053023339` のBlender成功artifactから `tests/blender/Cargo.lock` を固定。ZIP SHA-256 `3f49e5c168cb675b4ff32c1822514a5a7e427131533280d52d2842f5a9a1e0fe` を検証して取得した。
- tests/llm・tests/blenderともCI中のlock再生成をやめ、metadata/fetch/test/clippyを`--locked`で実行する。整形は自動修正ではなく`--check`とする。依存更新が必要な変更はlock差分と監査結果を別途提示する。
- PR #20のpolicy_transport/storage/llm_tests修正とV-C2を合わせた作業用checkoutでも、Rust23件・clippy `-D warnings`・fmt check成功。これは統合後の必須CIの代わりにはしない。
