# Opening preview sample

Macでアプリ本体の `MangaEngine`、`imageRequest`、原文参照、自由コマ割り、Canvas描画、preview転送処理を使う最小制作例です。上段の横長コマ、下段右の縦長コマ、下段左の小コマの3コマにします。生成画像は `review` のまま残します。

これはGUI操作やネイティブDBの保存・再起動試験ではありません。自然文演出、候補の採用／Undo、人物同一性の目視判定も別途必要です。#46 / #93 の完了判定には使いません。

## 入力

原稿・承認済み基準画・入力JSONはリポジトリの外へ置いてください。原稿は今回制作する冒頭だけを原文から抜き出します。`paragraphs` は見出しを除いた段落の0始まりインデックスで、すべての段落を順序どおり一度ずつ割り当てます。作画指示は外部入力に書き、登場する主要人物の `characterIds` と基準画を必ず指定します。

```json
{
  "workId": "sample-work",
  "episodeId": "opening",
  "title": "Opening sample",
  "source": "opening.md",
  "seed": 1042,
  "characters": [
    {"id":"person-a","name":"Person A","file":"reference.png","mime":"image/png"}
  ],
  "instruction": "Use the approved character reference and consistent clothing. No borders inside the image.",
  "panels": [
    {"paragraphs":[0],"prompt":"Wide establishing view appropriate to the first paragraph.","characterIds":[],"resolution":[768,384]},
    {"paragraphs":[1],"prompt":"Medium portrait of Person A, matching the second paragraph.","characterIds":["person-a"],"resolution":[512,768]},
    {"paragraphs":[2],"prompt":"Close detail appropriate to the third paragraph.","characterIds":["person-a"],"resolution":[512,512]}
  ]
}
```

上記は入力形式の例です。実際の原文に合う作画指示へ置き換えます。各パネルの `paragraphs` は複数指定も可能です。モデルへの画像入力、生成receipt、PNG寸法、描画後のアセットハッシュを検証し、不一致なら中断します。

## 制作

リポジトリ直下で、Apple Silicon Macの対応環境を用います（詳細は `docs/INSTALL_MAC.md`）。モデルの初回準備にはダウンロードと十分な空き容量が必要です。

```sh
npm ci
npx playwright install chromium
swift build -c release --package-path helper
helper/.build/release/manga-engine --prepare
node samples/opening-preview/run.mjs /private/path/input.json /private/path/new-output helper/.build/release/manga-engine
```

出力先は未作成ディレクトリを指定します。既存結果は上書きしません。`panel-N/result.png` とreceipt、各段階のcheckpoint、`project.json`、`prepared.json`、`assets/`、確認用 `page.png` が残ります。`project.json` はこのスクリプトの制作記録であり、アプリのネイティブ保存ファイルではありません。生成失敗時はcheckpointまで残り、自動再生成はしません。

`page.png` で人物・指・服装・原文との一致、文字の読みやすさ、コマ順を確認してから転送します。これらの私的ファイルを公開Actionsログや平文artifactへアップロードしないでください。

生成済みで描画だけが失敗した場合は `node samples/opening-preview/run.mjs --render /private/path/new-output` で描画を再開できます。モデルは再実行しません。生成前にChromiumの起動を確認し、各画像生成は15分を上限とします。

## 本番公開との関係

本番公開は、この出力を `live-manga` の `scripts/publish.mjs` に渡します。`--apply` を付けたときだけ、専用R2 S3資格情報で `releases/<releaseId>/` の不変アセットを検証付きで保存し、最後に `catalog.json` のcurrentを条件付きで更新します。読者は `/?release=<releaseId>` から読みます。GitHub ActionsやGitHubリポジトリは本番データの保存先ではありません。

今回の確認は本番公開にせず、同じ `prepareBrowserPreview` で作ったpreviewパッケージを、アプリの `transferPreview` と同じ契約で非公開Workerの `/previews/<work>/<episode>/transfers/<revision>` へ送ります。転送先だけが異なり、生成物の構造・ハッシュ検証・不足アセット再開・commit確認は本番側と同じ考え方です。`send.mjs` はこのPreview契約を呼ぶためのActions/CLI用入口です。本番R2の資格情報でPreviewへ送ることはしません。

## Preview転送

転送先は非本番Previewです。対象の作品・話に限定したwriter keyを環境変数 `PREVIEW_WRITE_KEY` に安全に設定します。Cloudflare Accessがある場合は、正規に発行されたservice tokenの `CF_ACCESS_CLIENT_ID` と `CF_ACCESS_CLIENT_SECRET` も必要です。認証情報を引数、入力JSON、リポジトリへ書かないでください。

```sh
node samples/opening-preview/send.mjs /private/path/new-output https://dev-live-manga.mashstock.workers.dev null
```

最後の引数は初回だけ `null`、既存previewを更新するときは確認済みのbase revisionです。失敗時は同じ出力先・origin・baseで再実行します。固定revisionと検証済みの不足アセットだけを使い、受信側のcommit確認後に `sent.json` を保存します。認証リダイレクトは追跡しません。

転送成功と閲覧成功は別です。`sent.json` のviewer URLを認証済みブラウザで開き、ページ表示を確認してください。本sampleは認証設定を変更しません。作品リポジトリにActionsを追加する必要はありません。

## 一時的にActionsのMacを使う場合

`.github/workflows/opening-sample.yml` は同じ本番helperとsampleをMac runnerで実行します。非公開入力は `input.cms`（CMS EnvelopedData / AES-256）として暗号化し、復号用秘密鍵だけを `MANGA_SAMPLE_DECRYPT_KEY` に設定します。入力tarには `input.json` と参照先の原文・画像を含め、通常ファイルだけを格納します。鍵はコード・ログ・artifactへ保存しません。

復号キーと対になる公開証明書 `recipient.pem` で結果も暗号化します。ジョブ失敗時も途中のcheckpointと診断ログを `encrypted-opening-result` artifactとして14日保存します。回収後は手元の秘密鍵で `openssl cms -decrypt -binary -inform DER -in opening-result.cms -inkey key.pem -out result.tar` として開けます。秘密鍵の回収可能な保管を確認してから実行してください。

転送には `MANGA_PREVIEW_WRITE_KEY`、Access service tokenを利用する場合は `MANGA_CF_ACCESS_CLIENT_ID` / `MANGA_CF_ACCESS_CLIENT_SECRET` を使用します。既存の広範なGitHub管理トークンを作品取得へ流用しません。入力は暗号化bundleだけから読みます。未設定なら転送は失敗として止まり、生成結果は暗号化保存します。

workflowは明示dispatch、または作業ブランチ `issue/46-work-4` の `run-request.txt` を更新したときだけ実行します。暗号化入力・公開証明書・秘密鍵の設定を確認した後に開始します。通常のコード修正で画像生成を繰り返しません。初回previewのbaseは `null` 固定です。既存previewの更新・再送は回収した出力に対して上記send CLIで行い、再生成しません。
