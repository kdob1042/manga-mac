# インストール・接続

Apple Silicon / macOS 14以降が対象です。通常のDMG導入にNode.js・Rust・Xcodeは不要です。ローカル画像モデル、Blender、Compositor、バックアップ用ツールは、使う機能だけ追加します。機能別のOS要件は下表を確認してください。

| 使いたい機能 | 追加の準備 |
| --- | --- |
| 演出・コマ計画 | 外部LLMのキー・モデルID、またはOllamaとモデル |
| ローカル作画 | アプリで選んだFLUXモデルを明示ダウンロード |
| クラウド作画・動画 | Runwayの用途別接続・送信許可・費用上限 |
| 3D構図・撮影 | Blender 4.5.13 |
| レイヤー分解 | Qwen Image Layered、macOS 15以降。編集には次行のCompositorも必要 |
| 外部レイヤー編集 | 連携版Compositor、macOS 26.5以降 |
| Live Manga出力・転送 | FFmpegのffprobe |
| クラウドバックアップ | 固定版restic / rcloneと既存Drive / OneDrive契約 |

各機能の実装と実機受入は別です。DMGに含まれる機能は生成元コミット、実測・残確認は[検証記録](VALIDATION.md)を参照してください。24GBでの生成速度・ピークメモリを未測定のまま保証しません。

## 1. アプリを入れる

1. MacでGitHubへログインし、[Manga MacのActions](https://github.com/kdob1042/manga-mac/actions/workflows/check.yml)を開きます。
2. mainの成功実行で `macOS release package` を確認し、Artifactsの `Manga-Mac-Apple-Silicon-unsigned` を取得します。
3. ZIPを展開し、DMGの `Manga Mac.app` をApplicationsへコピーして起動します。

`UI-test-results` やソースコードZIPはインストーラではありません。devの `macOS validation` 成果物は検証用です。DMGがなければログイン状態・mainのジョブ成功・Artifactsの期限を確認し、期限切れなら `Run workflow → main` で再生成します。ビルド失敗はアプリ側の修正が必要です。

初期配布は署名・公証が未設定です。出所を確認したDMGが「開発元を確認できない」で止まる場合は、一度起動を試してから **システム設定 → プライバシーとセキュリティ → このまま開く**。別の警告は全文を報告してください。端末全体の保護を無効にしません。[Appleの手順](https://support.apple.com/ja-jp/102445) / [GitHub成果物の取得](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/download-workflow-artifacts)

## 2. AIの接続を選ぶ

「接続・人物設定 → AIの接続」で、演出・コマ計画に使う接続先を選びます。同じ接続をBlender演出・英訳にも使います。

| 接続先 | 準備 |
| --- | --- |
| OpenAI / Gemini / Claude / DeepSeek | 利用可能なモデルID・APIキーを入力 |
| OpenAI互換API | HTTPSベースURL・モデルID・APIキーを入力 |
| Ollama | [Mac版](https://ollama.com/download/mac)を導入・起動し、使用モデルを取得 |

Ollamaの例:

```sh
ollama pull qwen3:8b
```

入力後に「接続をテスト」を押します。これは少量のテキストによるJSON応答の確認で、画像入力まで保証しません。互換APIがJSONモードに対応しない場合は設定をオフにできますが、JSONと原文IDの検証は続けます。

外部LLMには脚本・設定・人物説明、Blender演出では素材名・構図・操作結果を送ります。画像による対象認識は、対応モデルを選び画像送信を許可した場合だけ利用します。任意のJev接続も用途を確認して登録し、未設定なら選択済み演出LLMを使います。別事業者への自動切替はしません。

**APIキーとLLM接続は起動中のみ保持します。再起動後は再入力が必要です。** 接続先変更でキーを消去し、作品・バックアップ・履歴へ保存しません。外部APIは利用者のアカウントへ課金され、オンライン接続が必要です。演出LLMと画像生成先は別設定です。

## 3. 原稿と人物を接続する

「接続・人物設定」で原稿リポジトリを指定します。複数作品は原稿ライブラリで作品を選択し、dev / mainと取込対象の話を指定します。原稿形式は[設計§4.1](IMPLEMENTATION_PLAN.md#41-正本と参照)が正本です。

非公開原稿のトークンはGitHubのfine-grained tokenを使い、対象リポジトリの **Contents: Read-only** だけを付けます。ブラウザのログインとは別設定で、アプリ終了後は再入力します。原稿の変更・pushは行いません。

原稿ライブラリの「原稿の更新を確認」→差分確認→「取り込む」で、本文・設定・宣言済み人物参照を同一commitから取得します。原稿で宣言済みの人物画像を重複登録する必要はありません。原稿にない参照だけ人物名・固定特徴とともに登録します。PNG/JPEG/WebP、1枚20MB以下です。

## 4. 作画先を準備する

ローカルなら画像モデルを選び、準備ボタンで使用する重みだけ取得します。FLUX.2 klein 4Bには通常版と6-bit版があります。重みはDMGに含まず、起動・推論に伴う自動ダウンロードはしません。初回はネット接続と空き容量が必要です。

クラウドなら「Runway静止画の接続」でキー・作品のcredits上限・作画指示と参照の送信許可を登録します。Gen-4 Imageの対応入力と費用を画面で確認してください。クラウドだけを使う場合、ローカルFLUXの取得は不要です。

動画は「動画API接続」で使うモデル・キー・送信許可・累計予約上限を登録します。静止画・演出LLMとは別の用途です。接続登録だけでは有料生成を行いません。キーは起動中のみ保持し、再起動後は同じアカウントで再登録して既存taskを回収します。

準備が終わったら[取込みから完成までの操作](USAGE.md)へ進みます。

## 更新・バックアップ

新しいmainの成功DMGを取得し、アプリを終了してApplications内の本体を置き換えます。自動アップデートは未実装です。更新前は作品フォルダ全体を保存し、旧版へ戻す時は更新前のフォルダを別の復元先へ戻します。新形式を旧アプリで編集しません。

作品は `~/Library/Application Support/com.kdob1042.manga-mac/` 内に保存します。手動バックアップはアプリを終了してフォルダ全体をコピーしてください。SQLiteだけでは画像を、作品JSONだけでは動画・Blender素材を復元できません。`artifacts`・`blender`・`media`・`image-results` などを含めて保全します。

Blenderの `書類/Manga Mac/3D` にある素材と編集中のworking.blendはアプリ内クラウドバックアップの対象外です。書類のバックアップへ含めます。アプリに保存した固定撮影候補は対象です。外部アプリの未保存編集やDownloadsの書き出しも別途保管してください。

### クラウドバックアップの初回設定・別Mac復旧

初期状態は無効です。既存のGoogle Drive / OneDriveを使い、プラン契約・変更は行いません。実クラウド往復・Keychain・別Mac復元の受入は検証記録で確認してください。

1. `scripts/install-backup-tools.sh` を確認して実行します。例: `sh install-backup-tools.sh "$HOME/MangaBackupTools"`。空の絶対パスへ固定版restic / rcloneを取得し、配布元SHA-256を照合します。既存フォルダは上書きしません。
2. `"$HOME/MangaBackupTools/rclone" config --config "$HOME/MangaBackupTools/rclone.conf"` で専用remote `manga` を作り、typeを `drive` または `onedrive` にしてブラウザ認証します。`chmod 600 "$HOME/MangaBackupTools/rclone.conf"` で保護します。暗号化rclone設定は未対応です。
3. 「接続・人物設定 → クラウドバックアップ → 保存先を設定・再接続」でツール2本・設定ファイルの絶対パスと、保存先（例: `rclone:manga:manga-mac-backups/works`）を指定します。
4. 新しい空の保存先だけ「初期化する」を選び、12文字以上の復元パスワードを **Mac外のパスワード管理先にも保存**。再接続・別Macでは初期化せず同じパスワードを使います。Keychain自体はバックアップされません。
5. 「今すぐバックアップ」で全量検証の成功を確認し、「履歴を取得 → 別作品として復元 → この復元作品を開く」で原文・画像・動画・履歴を確認します。「元の作品を開く」で戻れます。作品切替は再起動を伴います。

週1回と手動で保存し、最新正常版は無期限、旧版は完了後21日で整理します。転送後の全量復元検証に失敗した回は旧正常版を削除しません。アプリ終了中は動かず、起動・復帰後に期限を確認します。失敗時は1時間間隔、2回失敗後は日次で再試行します。整理失敗は別表示し、クラウド全体のゴミ箱は空にしません。

restic repositoryをDrive等の通常同期クライアントで同時ミラーしないでください。Blenderの再現に必要な依存は保存候補へpackingしてからバックアップします。新しい保存形式の復元には対応版アプリが必要です。固定バージョン・検証hashはインストールスクリプトを正本とします。導入元は [restic](https://github.com/restic/restic/releases/tag/v0.19.1)（BSD-2-Clause）と [rclone](https://github.com/rclone/rclone/releases/tag/v1.75.1)（MIT）。DMGへの同梱や暗黙の最新版取得は行わず、更新時は公式配布物を再検証します。

## アプリからBlenderを開く（#197）

Blender 4.5.13をApplicationsへ入れ、対象コマの詳細調整で「このコマのBlenderを開く」を押します。起動・ローカル認証・接続はアプリが行うため、通常は手動アドオン導入が不要です。

「素材フォルダを開く・再読込」で作品のassetsへ標準blendやCatalogを置き、初回用blendを選べます。続きはworking.blendを開きます。作業保存は「作業ファイルを保存」、撮影候補は「新しい候補版へ保存」です。元素材と採用済みcheckpointは直接編集しません。

別コマへ移る前は作業を保存して現在の接続を切断します。Blender自体は閉じません。アプリだけ再起動した場合は次の手動接続で戻れます。動画撮影も同じGUIを使います。

### 自分で開いたBlenderに接続する

1. リポジトリrootで `python3 scripts/package-live-addon.py` を実行し、`dist/manga_mac_live.zip` をBlenderの Preferences → Add-ons → Install from Diskで導入・有効化します。
2. アプリ保存領域の外にある作業用blendを開き、3D ViewのNパネル → Manga Live → Start local connectionを選びます。
3. アプリ設定の「開いているBlenderへlive接続」でinstance / token / file（未保存なら空）/ Scene / View Layerを入力します。127.0.0.1限定で、tokenは作品に保存しません。
4. file / scene / cameraを確認し、対象コマへ明示割当します。別fileの読込・undo / redo後は再接続・再割当・人物対応の確認が必要です。

同じportに接続アドオンを重ねて起動しません。採用済みcheckpointとそのsymlinkへの直接接続は拒否します。旧候補を編集する時は「採用中の版を作業用コピーへ書き出す」で新しいコピーを開いてください。

### MacのCodexで同じBlenderを操作する

1. 対象コマをliveに割り当て、「MacのCodexへ渡す」で操作権を渡します。保存された制作依頼ZIPをCodexへ渡してください。原文・参照・作業場所を含み、接続tokenは含みません。
2. MCP対応のCodexには `http://127.0.0.1:9877/mcp`（変更時はそのport）とManga LiveのBearer tokenを接続設定で指定します。tokenを指示文・作品・リポジトリへ保存しません。
3. `live_identity` で対象確認→ランダムなclient IDとinstance / epochで `live_claim`→`live_observe`→`live_resume`→`live_act`→再観測の順に操作します。任意Python実行は提供しません。
4. Computer Useを使う場合はCodex側で機能と画面操作権限を用意します。このアドオンだけでは追加されません。
5. Codexの画面操作を終え、MCPを占有していれば `live_release`。アプリで「操作権を戻し、再観測する」を押し、人物対応を確認します。

MCPの排他はOSのマウス・キーボードをロックしません。同時に操作せず、応答不明ならGUIと保存結果を照合します。Mac上の通し確認は[検証記録](VALIDATION.md#mac上のcodexによる実地確認184--186--187)を参照し、OS権限など本人操作が必要な箇所だけ利用者へ依頼します。

### Tripo任意接続

設定の「Blenderで撮影する → 参照画像から3Dモデルを作る（Tripo・任意）」でAPIキー・作品のcredits上限・送信許可を登録します。登録だけでは画像を送信せず、キーは起動中nativeメモリのみです。

正本画像1枚を選び、生成→状態照会→GLB取得→同じBlender GUIへ取込みの順に進みます。取得時はGLB形式・512MB上限・hashを検証します。応答不明なら保存済みtaskを確認し、自動再送しません。現経路は `image_to_model / v2.5-20250123`。形状・テクスチャ・ライセンス・人物同一性を確認して既存撮影へ進めます。実API受入は別途必要です。

## Compositor連携版（開発中、#217）

連携版のビルドには開発環境が必要です。上流がmacOS 26.5以降を要求し、標準Compositorには外部接続口がありません。`bash integrations/compositor/build.sh <空のビルド先>` で固定版をビルドし、`derived/Build/Products/Release/Compositor.app` を `~/Applications/Compositor Manga.app` へ配置します。

通常の漫画制作には不要です。分解する場合だけ「原画をレイヤーに分解」でQwen Image Layeredを明示準備します。対応は64px刻みの256〜1024px、2〜6層。推論時の自動取得・別backendへの退避はしません。操作は[使い方のレイヤー編集](USAGE.md#レイヤーで直す)へ進みます。

Codexへ渡した後は `python3 integrations/compositor/client.py <session-ID> state` で観測し、instance / document / revisionを `--arguments` に含めて限定操作します。終了時にhandoffでappへ返すか、アプリの「アプリに戻す」で再観測・回収します。接続tokenを出力・保存しません。

## Live Mangaの配信用書き出し

FFmpegのffprobeを用意します。Homebrew環境なら `brew install ffmpeg`。アプリは `/opt/homebrew/bin/ffprobe` / `/usr/local/bin/ffprobe` またはPATHから検出します。未導入でも漫画制作・PNG / CBZ出力は使えます。

配信側はLive Manga v2対応が必要です。実H.264・無音・寸法・尺・hashを検証し、非対応動画は自動再エンコードしません。出力は `Downloads/live-manga-<releaseId>` の不変刊行フォルダです。既刊版の上書き・クラウド自動公開は行いません。

非公開プレビューには、管理者が用意したHTTPS Worker originと作品・話限定の転送キーを設定します。保存先は非公開R2で、R2管理キーは入力しません。閲覧は別の読取りキーです。未設定時に公開URLへ迂回しません。

初回の基準版は空欄、更新は前回の現在版を引き継ぎます。再起動後の再開は転送版ID・同じorigin・基準版を指定します。転送キーは画面メモリだけで保持し、作品・話の切替で消去します。Worker・bucket・認証の準備と別端末への通し確認は必要ですが、この画面はクラウド契約や課金を自動設定しません。

## 困ったとき

| 症状 | 確認すること |
| --- | --- |
| DMGがない | mainの `macOS release package` 成功・ログイン・Artifactsの期限 |
| LLMに接続できない | 選択先・モデルID・キー、またはOllamaの起動 |
| GitHub 401 / 403 / 404 | 原稿リポジトリ名・トークン対象・期限・Contents権限 |
| 画像エンジンがない | 正式なMacビルド成果物か確認 |
| モデル準備・生成に失敗 | エラー全文、チップ・メモリ・macOS版、取得したビルド実行URL |
| 再起動後に接続できない | API接続とGitHubトークンを再入力 |
| 要求の結果が不明 | 再送せず保存済みJob・候補の回収と照合 |

報告にAPIキー・トークンを含めないでください。開発用の起動・テストは[開発案内](DEVELOPMENT.md)、日常操作は[使い方](USAGE.md)にまとめています。
