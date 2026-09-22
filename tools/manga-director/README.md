# アプリ外 Manga Director

`#263` の反復処理を Node 22 以降で実行するための入口です。Tauri、manga-macの起動、SQLite、画像・動画生成は使いません。依存パッケージの追加もありません。コードの配置がmanga-macリポジトリ内であることと、アプリを実行することは別です。作品RepoからこのCLIを呼び出せます。

設計正本は `../../docs/IMPLEMENTATION_PLAN.md`、責務の変更と残る統合は [#265](https://github.com/kdob1042/manga-mac/issues/265) を参照してください。この文書は実行方法とAPI境界だけを記載します。

## 現在の到達点

反復制御、作業用原稿への型付き編集、停止・取消、差分と履歴の保存を実装しています。共通name-plan/v2の検証器（#253）と1回のネーム生成（#255）を複製せず、明示的なhost adapterで呼びます。

**その共通実装への実接続・実LLM・#257への取込受入は#265で未完了です。** 同梱のfixtureは試験専用で、実ネームAIやname-plan/v2実データの代用品ではありません。CLIが存在するだけで、任意の作品を実AIで最後まで実行できるとは扱いません。

## 起動

信頼できるhost adapterを準備した環境で実行します。

```sh
node /path/to/manga-mac/tools/manga-director/cli.mjs \
  --root /path/to/story-repo \
  --input /path/to/director-input.json \
  --adapter /path/to/trusted-host.mjs \
  --out /path/to/existing-parent/new-run
```

`--out`は未作成のディレクトリを指定します。親ディレクトリは先に用意してください。同名実行の上書き・原稿の書き戻しはしません。`--help`で制限を確認できます。標準は3周・モデル呼出予約6回・1段階120秒・追加本文2000 Unicode scalar・追加ページ2枚が上限です。回数の上限を増やしても呼出予算は自動では増やしません。

入力は既存の原稿snapshotと選択範囲・read-only文脈です。一時的な実行入力であり、作品の第2の正本manifestではありません。#265でstory-source/v1の既存読込処理へ接続します。

```json
{
  "snapshot": {
    "id": "external-snapshot-1",
    "workId": "example-work",
    "scenes": [{"id": "scene-1", "path": "manuscript/p01/p01-01.md"}]
  },
  "selectedSceneIds": ["scene-1"],
  "context": {"characterNotes": "同じ原稿版から取得した人物設定・前後文脈"}
}
```

sceneは`text`を直接持つこともできます。`path`は`--root`からの相対パスです。両方ある場合はファイル本文との完全一致が必要です。上位パス・絶対パス・シンボリックリンクは原稿入力として拒否します。明示されたファイル以外、特に`.env`や認証設定は探索しません。元のsnapshotが持つrepo/commit等の来歴は保持してください。

## Host adapterの契約

`adapter.mjs::createDirectorAdapter({name, version, planName, validateName, complete})`が返す値をhostファイルからdefault exportします。

- `planName(request, {signal})`: #255の1回生成を呼び、生の共有name-planを返します。入力には現在のsnapshot、対象scene IDs、read-only文脈、前案とそのsnapshot、演出指示があります。
- `validateName({plan, snapshot, selectedSceneIds}, {signal})`: #253の実検証器を呼び、`{ok, contract:'name-plan/v2', validatorVersion, pageIds, panelIds}`を返します。モデルの自己申告を検証結果にしてはいけません。
- `complete(messages, {signal})`: 明示設定したホストでreviewだけを1回実行し、JSONオブジェクトまたはJSON文字列を返します。reviewの実行プロンプトは`review.mjs`にあります。計画用の演出カードは#255の所有です。

adapterはユーザーが明示選択する通常の実行コードであり、サンドボックスではありません。原稿やAI応答からadapterのパスを選んではいけません。各callbackはAbortSignalを尊重し、自動再試行・別providerへのfallbackを行わず、既存の送信許可と費用上限を守る必要があります。認証情報はhostの環境に置き、原稿入力や返却値に混ぜないでください。停止した外部要求の結果が不明な場合、再送前にホスト側で確認します。

## 生成物と停止

新しい実行ディレクトリに、`input-snapshot.json`、`working-manuscript.json`、`name-plan.json`（検証・review済み候補がある場合）、`script-suggestions.json`、`final-diff.json`、`events.jsonl`を保存し、最後に`result.json`を作成します。ファイルは0600、ディレクトリは0700です。`result.json`がない実行は未完了で、自動再開・再送はしません。標準出力には本文・モデル応答・生の例外メッセージを出しません。

`final-diff.json`は変更sceneの元本文・候補本文と各SHA-256です。適用前に人が確認する差分であり、自動適用機能はありません。各反復の提案は`trial`、`retained_in_working`、`rolled_back`等で記録し、ユーザーが採用した事実とは分けます。

改稿時は新しい`working:...`のsnapshot IDを与え、commitをnullにし、元版を`directorProvenance`に保持します。以前の指示・前案は以前のsnapshotと対で渡し、古いoffsetに新IDを付けて再利用しません。最終出力は必ず同じ版の原稿とネームの組です。失敗・悪化時には直前のreview済みの組を保持します。

`no_major_issues`でも状態は`review_required`、人の承認は`pending`です。意味上の改善はAIの判断で、読者評価の実証ではありません。改善停止は未解決major×3＋minorの件数、提案の正規化fingerprint、本文/ページ増、呼出予算と最大周回数で判断します。fingerprintは同一表現の反復検出であり、あらゆる言い換えの意味同一性を保証しません。新しい出来事が紛れたかという意味判断も人の確認が必要です。

原稿差分の承認・反映後は、#253/#254で確定原稿へ参照を結び直してから#257に渡します。作業中のネームを旧原稿へそのまま適用してはいけません。正本hash変更、不正参照、解釈不能なJSON等では停止し、自動修復や別モデルの課金要求は追加しません。

## 試験

```sh
node --test tests/manga-director.test.js
```

既存`npm test`の`tests/*.test.js`にも含まれます。2周・原稿不変・混合提案の版・Unicode scalar・上限・巻戻し・取消・CLI保存・原稿競合を検査します。fixtureでCLIを確認する場合だけ`--allow-fixture`を付けます。出力は`mode:fixture`と`TEST_ONLY_NOT_A_NAME_PLAN`で明示し、実モデル品質・共通v2検証・実アプリ取込の成功には数えません。
