# インストール・接続

Apple Silicon / macOS 14以降が対象です。通常のDMG導入にNode.js・Rust・Xcodeは不要です。ローカル画像モデル、Compositor、バックアップ用ツールは、使う機能だけ追加します。機能別のOS要件は下表を確認してください。

| 使いたい機能 | 追加の準備 |
| --- | --- |
| 演出・コマ計画 | 外部LLMのキー・モデルID、またはOllamaとモデル |
| ローカル作画 | アプリで選んだFLUXモデルを明示ダウンロード |
| クラウド作画・動画 | Runwayの用途別接続・送信許可・費用上限 |
| 3D構図・撮影 | アプリ内の3Dステージ |
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

「接続・人物設定 → AIの接続」で、演出・コマ計画に使う接続先を選びます。同じ接続を構図案・英訳にも使います。

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

外部LLMには脚本・設定・人物説明、構図案では素材名・構図・操作結果を送ります。画像による対象認識は、対応モデルを選び画像送信を許可した場合だけ利用します。任意のJev接続も用途を確認して登録し、未設定なら選択済み演出LLMを使います。別事業者への自動切替はしません。

**APIキーとLLM接続は起動中のみ保持します。再起動後は再入力が必要です。** 接続先変更でキーを消去し、作品・バックアップ・履歴へ保存しません。外部APIは利用者のアカウントへ課金され、オンライン接続が必要です。演出LLMと画像生成先は別設定です。

## 3. 原稿と人物を接続する

「接続・人物設定」で原稿リポジトリを指定します。複数作品は原稿ライブラリで作品を選択し、dev / mainと取込対象の話を指定します。原稿形式は[設計§4.1](IMPLEMENTATION_PLAN.md#41-正本と参照)が正本です。

非公開原稿のトークンはGitHubのfine-grained tokenを使い、対象リポジトリの **Contents: Read-only** だけを付けます。ブラウザのログインとは別設定で、アプリ終了後は再入力します。原稿の変更・pushは行いません。

ローカルにGit管理の原稿がある場合は、アプリのデータフォルダ `~/Library/Application Support/com.kdob1042.manga-mac/local-source.json` に次の設定を保存すると、そのリポジトリから読み取れます。指定したリポジトリではトークンは不要です。

```json
{"repo":"kdob1042/story-library","path":"/absolute/path/to/story-library"}
```

アプリで「原稿を開く」「変更を確認」または「更新を確認」を押すと、選択した `dev` または `main` を `origin` から取得します。その後、本文と参照画像を同じcommitのGitオブジェクトから読みます。ターミナル操作は不要です。作業ツリーは読み書きせず、アプリはpullやpushを実行しません。取得に失敗した場合は古いcommitへ黙って戻らず、画面にエラーを表示します。設定ファイルを削除するとGitHub APIからの読取りに戻ります。originが指定したGitHubリポジトリと一致しない場合は取得を止めます。作業ツリーや未pushのcommitは読みません。

原稿ライブラリの「原稿の更新を確認」→差分確認→「取り込む」で、本文・設定・宣言済み人物参照を同一commitから取得します。原稿が同じでもネーム等だけが変わったcommitを採用でき、画面に取得方法・確認SHA・採用SHAを表示します。「取り込む」前にブランチが動いた場合は再確認を求めます。原稿で宣言済みの人物画像を重複登録する必要はありません。原稿にない参照だけ人物名・固定特徴とともに登録します。PNG/JPEG/WebP、1枚20MB以下です。

宣言された参照画像のバイト列がPNG/JPEG/WebPではない場合、その画像だけを除外して名前とパスを原稿の取込結果に記録・表示します。本文と正常な画像は取り込めます。画像元を修正した後、更新確認から取り込み直してください。通信失敗や読み取り失敗では取込みを止めます。

## 4. 作画先を準備する

ローカルなら画像モデルを選び、準備ボタンで使用する重みだけ取得します。FLUX.2 klein 4Bには通常版と6-bit版があります。重みはDMGに含まず、起動・推論に伴う自動ダウンロードはしません。初回はネット接続と空き容量が必要です。

クラウドなら「Runway静止画の接続」でキー・作品のcredits上限・作画指示と参照の送信許可を登録します。Gen-4 Imageの対応入力と費用を画面で確認してください。クラウドだけを使う場合、ローカルFLUXの取得は不要です。

動画は「動画API接続」で使うモデル・キー・送信許可・累計予約上限を登録します。静止画・演出LLMとは別の用途です。接続登録だけでは有料生成を行いません。キーは起動中のみ保持し、再起動後は同じアカウントで再登録して既存taskを回収します。

準備が終わったら[取込みから完成までの操作](USAGE.md)へ進みます。

## 更新・バックアップ

新しいmainの成功DMGを取得し、アプリを終了してApplications内の本体を置き換えます。自動アップデートは未実装です。更新前は作品フォルダ全体を保存し、旧版へ戻す時は更新前のフォルダを別の復元先へ戻します。新形式を旧アプリで編集しません。

作品は `~/Library/Application Support/com.kdob1042.manga-mac/` 内に保存します。手動バックアップはアプリを終了してフォルダ全体をコピーしてください。SQLiteだけでは画像を、作品JSONだけでは動画・3D素材を復元できません。`artifacts`・`scene-assets`・`media`・`image-results`（旧版の`blender`も保全） などを含めて保全します。

旧版で保存された撮影候補は復元対象です。旧作業ファイルを残す場合は書類側のバックアップにも含めてください。

### クラウドバックアップの初回設定・別Mac復旧

初期状態は無効です。既存のGoogle Drive / OneDriveを使い、プラン契約・変更は行いません。実クラウド往復・Keychain・別Mac復元の受入は検証記録で確認してください。

1. `scripts/install-backup-tools.sh` を確認して実行します。例: `sh install-backup-tools.sh "$HOME/MangaBackupTools"`。空の絶対パスへ固定版restic / rcloneを取得し、配布元SHA-256を照合します。既存フォルダは上書きしません。
2. `"$HOME/MangaBackupTools/rclone" config --config "$HOME/MangaBackupTools/rclone.conf"` で専用remote `manga` を作り、typeを `drive` または `onedrive` にしてブラウザ認証します。`chmod 600 "$HOME/MangaBackupTools/rclone.conf"` で保護します。暗号化rclone設定は未対応です。
3. 「接続・人物設定 → クラウドバックアップ → 保存先を設定・再接続」でツール2本・設定ファイルの絶対パスと、保存先（例: `rclone:manga:manga-mac-backups/works`）を指定します。
4. 新しい空の保存先だけ「初期化する」を選び、12文字以上の復元パスワードを **Mac外のパスワード管理先にも保存**。再接続・別Macでは初期化せず同じパスワードを使います。Keychain自体はバックアップされません。
5. 「今すぐバックアップ」で全量検証の成功を確認し、「履歴を取得 → 別作品として復元 → この復元作品を開く」で原文・画像・動画・履歴を確認します。「元の作品を開く」で戻れます。作品切替は再起動を伴います。

週1回と手動で保存し、最新正常版は無期限、旧版は完了後21日で整理します。転送後の全量復元検証に失敗した回は旧正常版を削除しません。アプリ終了中は動かず、起動・復帰後に期限を確認します。失敗時は1時間間隔、2回失敗後は日次で再試行します。整理失敗は別表示し、クラウド全体のゴミ箱は空にしません。

restic repositoryをDrive等の通常同期クライアントで同時ミラーしないでください。旧版の固定撮影候補もバックアップ対象です。新しい保存形式の復元には対応版アプリが必要です。固定バージョン・検証hashはインストールスクリプトを正本とします。導入元は [restic](https://github.com/restic/restic/releases/tag/v0.19.1)（BSD-2-Clause）と [rclone](https://github.com/rclone/rclone/releases/tag/v1.75.1)（MIT）。DMGへの同梱や暗黙の最新版取得は行わず、更新時は公式配布物を再検証します。

## 3D素材を使う

手持ちのGLBをアプリへ取り込み、コマの3Dステージで配置・ポーズ・カメラを調整します。不足した素材はTripoから生成し、取得後にGLBとして再利用できます。TripoはAPIキー、credits上限、送信許可を登録してから人物参照を送信します。応答が不明な要求は自動再送しません。

## Compositor連携版（開発中、#217）

連携版のビルドには開発環境が必要です。上流がmacOS 26.5以降を要求し、標準Compositorには外部接続口がありません。`bash integrations/compositor/build.sh <空のビルド先>` で固定版をビルドし、`derived/Build/Products/Release/Compositor.app` を `~/Applications/Compositor Manga.app` へ配置します。

通常の漫画制作には不要です。分解する場合だけ「原画をレイヤーに分解」でQwen Image Layeredを明示準備します。対応は64px刻みの256〜1024px、2〜6層。推論時の自動取得・別backendへの退避はしません。操作は[使い方のレイヤー編集](USAGE.md#レイヤーで直す)へ進みます。

Codexへ渡した後は `python3 integrations/compositor/client.py <session-ID> state` で観測し、instance / document / revisionを `--arguments` に含めて限定操作します。終了時にhandoffでappへ返すか、アプリの「アプリに戻す」で再観測・回収します。接続tokenを出力・保存しません。

## Live Mangaの配信用書き出し

FFmpegのffprobeを用意します。Homebrew環境なら `brew install ffmpeg`。アプリは `/opt/homebrew/bin/ffprobe` / `/usr/local/bin/ffprobe` またはPATHから検出します。未導入でも漫画制作・PNG / CBZ出力は使えます。

配信側はLive Manga v2対応が必要です。実H.264・無音・寸法・尺・hashを検証し、非対応動画は自動再エンコードしません。出力は `Downloads/live-manga-<releaseId>` の不変刊行フォルダです。既刊版の上書き・クラウド自動公開は行いません。

非公開プレビューには、管理者が用意したHTTPS Worker originと作品・話限定の転送キーを設定します。保存先は非公開R2で、R2管理キーは入力しません。閲覧は別の読取りキーです。未設定時に公開URLへ迂回しません。

初回の基準版は空欄、更新は前回の現在版を引き継ぎます。再起動後の再開は転送版ID・同じorigin・基準版を指定します。転送キーは画面メモリだけで保持し、作品・話の切替で消去します。Worker・bucket・認証の準備と別端末への通し確認は必要ですが、この画面はクラウド契約や課金を自動設定しません。

## LTX-2.5 MLXでローカル動画を作る（実験的・#166）

Apple Silicon Mac専用です。24GBでのモデル実推論・性能は未受入です。API料金はかかりませんが、ディスク容量・メモリ・生成時間とモデル利用条件は別途必要です。

1. [ltx-2-mlx](https://github.com/dgrauet/ltx-2-mlx/tree/3d08a953957fbc4269093d4da2f88db5bc12f86b)を導入してください。接続実装が参照したcommitは`3d08a953957fbc4269093d4da2f88db5bc12f86b`です。Python 3.11以上・uv等の依存関係は同リポジトリの手順に従います。
2. [LTX-2.5 MLX q4 pack](https://huggingface.co/dgrauet/ltx-2.5-mlx-q4)の利用条件に同意し、tokenizer・設定・text encoder・connector・distilled transformer・VAE/音声部品・spatial_upscaler_x2_v1_0を含む一式をローカルへ取得してください。アプリはダウンロードや認証を代行しません。登録時のファイル検査は完全なモデル実行検証ではありません。
3. `brew install ffmpeg`等でFFmpegとffprobeを導入します。ffprobeはHomebrew標準パスまたはPATHに必要です。
4. 動画画面の「動画の生成先」を「LTX-2.5 MLX」に変更。`…/ltx-2-mlx/.venv/bin/ltx-2-mlx`、モデルフォルダ、FFmpegの**絶対パス**を入力し、信頼できる実行ファイル・利用条件を確認して登録します。設定は再起動後に再登録が必要です。
5. 開始画像を選び、ショットの寸法を512:512 / 512:320 / 320:512にして保存します。同じ縦横比のPNGが必要です。終端画像を使うA→Bは今回対象外。必要なら開始画像1枚の別ショットを作ります。
6. 「5秒の動画を生成する」。最大60分、他の重いAI処理と直列に動作します。完了後は候補を再生して確認し、明示的に採用します。結果は無音H.264 MP4です。

失敗時はモデル一式、上記CLI版との互換性、空きメモリ、FFmpeg/ffprobeを確認してください。自動再送・Runwayへの自動切替はしません。異常終了後のunknown要求は、Activity Monitorでltx-2-mlx・関連Python/FFmpegの停止を確認してから「採用せずローカルで解決する」を使用します。強制終了時は作品フォルダの`local-video-<UUID>`に未採用の途中ファイルが残る場合があります。アプリを閉じ、該当処理の停止を確認するまで触らないでください。

受入では実際の作画/撮影画像で生成→再生→採用→再起動→MP4書出しを試し、CLI commit・model pack・Mac機種/RAM・実行時間・最大メモリを記録してください。共通テストの疑似CLI/青い動画は、モデル実推論の確認には含めません。

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

## 実機確認を始める（#266）

診断対応版のDMGと同じArtifacts内にある `mac-acceptance-kit` を使います。通常アプリをApplicationsへ配置した後、ターミナルでkitへ移動して次の2行を実行します。Node・Python・開発環境は不要です。

```sh
sh mac-acceptance-preflight.sh
sh mac-acceptance-smoke.sh
```

1行目はOS・チップ・メモリ・空き容量、アプリ／helper／モデル定義の版を読むだけです。モデル・LLM・原稿の接続確認は `NOT_RUN` と表示し、通信・ダウンロード・作品変更は行いません。必須条件がFAILなら2行目へ進まず、表示された項目を直します。

2行目は専用の確認画面を開きます。通常作品とは別の保存先です。通常アプリで **FLUX.2 klein 4B / 6-bit** を明示準備してから「最小制作確認を実行」を押すと、人工原稿→本番ネームv2 compilerの全面1コマ→256×256・4ステップの作画1枚→日本語文字→strict proof→本番のSQLite保存／読込→ページPNGを確認します。起動だけでは生成せず、モデル未取得ならオフラインで失敗し、自動ダウンロードしません。LLMによるネーム案生成・実原稿P01・画質はこの人工fixtureの合格に含めません。

完了後は確認用アプリを終了し、ターミナルに表示されたUUIDで再起動します。

```sh
sh mac-acceptance-smoke.sh --session 表示されたUUID
```

「再起動後の保存内容を確認」で、前回起動時に保存した作品・作画hashを照合します。生成済み画像は再利用します。未確定要求は「保存済み結果を回収」だけで確認し、同じ要求を再送しません。回収できない要求はそのセッションを残して原因を調べます。新しいUUIDは新しい確認として明示的に始める場合だけ使います。

| 停止した項目 | 次の操作 |
| --- | --- |
| app / image_helper | 診断対応版の成功DMGを入れ直す |
| macOS / apple_silicon | 実際の機種・OSと必要条件を照合する |
| モデル未取得 | 通常アプリの6-bitモデルを明示準備する |
| 生成失敗／応答未確定 | 保存済み結果を回収。なければ同じ要求を再実行せず原因を確認する |
| 保存／PNG失敗 | 表示エラーと空き容量を確認し、成功済み作画から再開する |
| 再起動hash不一致 | 同じUUIDとアプリ版を確認し、証跡を残して修正する |

結果は専用保存先の `acceptance-report.json` に記録します。通常作品、APIキー、原稿本文、人物画像、任意のエラー文字列は含めません。エラー全文は確認画面で読めますが、Issueへ貼る前に内容を確認してください。生成時間は記録し、ピークメモリ・スワップの実測は別途#266へ残します。判定できない項目をPASSにしません。

開発版を調べる場合だけ、同じ2スクリプトに `--executable /absolute/path/to/manga-mac` を渡します。通常のDMG手順と混ぜず、kitの `build-provenance.json` と実行結果のアプリSHAを記録してください。診断のruntimeKindはアプリbundle／単体実行を区別し、build.sourceはビルド時の来歴です。DMG自体のhashはkitで照合します。別ビルドで同じ確認セッションを再開すると、版混同を防ぐため停止します。
