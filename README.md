# Manga Mac — ローカル漫画制作アプリ

完成脚本をGitHubのmainから読み取り専用で取得し、原文を保持した演出計画、参照付き作画、領域編集、ページ出力を行うTauri 2 + React + Rust + Swiftアプリです。

**現在は初期実装・実機検証前です。完成版ではありません。** LinuxでWebビルドとドメインテストを実行済み。Apple Silicon上の推論品質、メモリ使用量、オフライン動作、配布物のクリーンインストールは未検証です。

## 使い方

1. GitHub Actionsの `Check and build Mac app` が成功した実行から `Manga-Mac-Apple-Silicon-unsigned` を取得します。macOS 14以降のApple Silicon向けです。ビルド失敗中はDMGは存在しません。
2. DMG内のManga Mac.appをApplicationsへコピーします。初期ビルドは署名・公証されていません。
3. Ollamaを別途インストールして起動し、`qwen3:8b` などのローカルモデルを取得します。現段階ではOllamaを同梱していません。
4. 「接続・人物設定」で原作リポジトリ（初期値 `kdob1042/Kamiya-Kawai`）、話ID、必要ならContents: readのみのfine-grained tokenを指定します。トークンはメモリのみ保持しSQLiteやログへ保存しません。
5. 更新を確認し「この版を取り込む」。人物名・固定特徴・正本画像を登録します。
6. 「画像モデルを準備する」でFLUX.2 klein 4Bのモデルを取得します。ダウンロード容量・処理時間は環境に依存します。
7. 「漫画にする」で各場面を計画・逐次作画します。保存済み画像は再生成せず再開できます。
8. 表情を直す場合は人物を選んで自然言語で指示します（別途qwen3-vl:4bが必要）。またはコマの画像をドラッグして修正可能領域を指定します。範囲外のRGBA画素は元画像から復元します。
9. 人物・原作整合を確認し、PNG/CBZへ出力します。Macでは「ダウンロード/Manga Mac」に日時付きファイル名で保存し、既存ファイルを上書きしません。文字が入り切らない場合は省略せずエラーにします。

## 実装した境界

- 実際のKamiya-Kawai schema_version 2に対応。`episodes[].scene_ids` の順で `scenes[].path` / `design_path` / `settings[].path` を取得。ファイル名でソートせずarchive/build/revisionsを取り込みません。
- mainのSHAを一度取得し、全ファイルを同じ40桁SHAで取得。同期取得失敗は現行スナップショットに影響しません。新版取得と適用は別操作。起動時と5分おきに更新確認し、制作中は同期を保留します。
- 原文の段落IDをLLMへ渡し、全IDの順序・一意性・完全性を検証。表示原文はスナップショットから直接取得。AI出力で台詞を上書きしません。
- キャラの画像バイト列をSHA256で記録し、Rustでも照合してからSwiftのmoodboard入力へ渡します。入力順、人物ID、ハッシュ、モデル、seed、寸法、ステップ数をコマに記録します。見た目の一致は保証しません。
- 画像生成は専用プロセスのMediaGenerationKit `.local` のみ。処理完了後プロセスが終了しモデルメモリを解放。Ollamaはkeep_alive: 0。
- 同時画像ジョブは1つ。進行中/成功/失敗ジョブを保存。停止は現在の処理終了後。各コマ完了時にSQLiteへ保存し再起動後に再開可能。
- 編集履歴は保存済み画像を保持。選択外のコマは変更せず、undoは再推論しません。
- SQLite WALで作品を保存。画像・スナップショット・ジョブ・履歴を含むJSONをトランザクションで更新。大量作品向けの画像ファイル分離は今後の改善項目です。

## 未完・制約

- Qwen3-VLで正本と生成画像を照合する顔の矩形推定を実装しています（実機精度未検証）。人物を選んで指示すると推定範囲だけ編集します。特定失敗時は手動矩形選択を求めます。SAMの画素単位マスク、生成後の同一性検査と自動修復は未実装です。
- コマ内の自動吹き出し配置・日本語縦書き/Core Textは未実装。原文は画像下の独立文字層として保持します。地の文も省略しないため、長い段落は組版調整が必要です。
- 原作変更時は変更場面（設定変更時は対象の全場面）の再計画。意味差分による台詞のみ更新、矛盾しない演出修正の自動引継ぎ、ETagは未実装。旧画像と履歴はスナップショットに紐づき保持されます。
- キャラクター参照の交換UI、複数作品切替、バックアップ復元UIは未実装。作品JSONのバックアップ出力は可能です。
- 自動モデル導入は画像モデルのみ。Ollamaの導入は手動。モデル重みは配布物に含みません。
- Swift helperは現行公開APIに基づく初期実装。moodboard入力での二人のキャラ保持、長辺768pxでの速度・品質・24GBメモリ条件を実機で検証していません。
- 署名・公証・アップデータは未設定。通常配布前に署名情報を設定し、開発ツールのないMacで検証が必要です。

## 開発

```sh
npm ci
npm test
npm run build
npm run dev
```

ブラウザでは空作品のサンプル表示と組版画面を確認できます。GitHub認証・推論はRust IPCを通すためMacアプリ限定です。ブラウザからクラウドAIへ送信しません。

macOS開発環境での起動:

```sh
swift build -c release --package-path helper
mkdir -p src-tauri/binaries
cp helper/.build/release/manga-engine src-tauri/binaries/manga-engine-aarch64-apple-darwin
npm run tauri dev
```

GitHub ActionsでWebテスト後、macOSのSwiftエンジンとTauri DMGをビルドします。実機の生成受入試験の代替にはなりません。

## 実機受入試験

1. 2人の正本を登録し、2人が登場するコマで両方の参照ID/ハッシュを確認する。
2. 一人の顔領域を選び表情を変更。保存PNGをRGBA比較してマスク外差分ゼロを確認する。
3. 再起動し、履歴・参照・原作SHA・失敗ジョブを確認する。
4. 元に戻す操作で旧画像が厳密一致することを確認する。
5. モデル導入後にネットを遮断して、Ollamaを選んだ状態で取得済み原作の生成・編集・保存・出力を試す。
6. 二人の顔/衣装の混線、生成速度、ピークメモリを記録する。合格前に参照品質の数値を宣言しない。

## 出典と依存

- [Tauri 2](https://v2.tauri.app/)
- [MediaGenerationKit](https://github.com/drawthingsai/media-generation-kit/tree/8868a9685d9c299816f43ef53efd455ffca437f0) — リビジョン固定、LGPLv3。再配布時は同ライセンスの義務を確認してください。
- [Ollama API](https://docs.ollama.com/api/chat)
- [GitHub Contents API](https://docs.github.com/en/rest/repos/contents)

原作リポジトリへの書き込み機能はありません。漫画アプリのコードはこのmanga-macリポジトリで管理します。

## LLMの接続先を選ぶ

「接続・人物設定」→「AIの接続」で、**演出・コマ計画**と**顔の範囲推定**を個別に選べます。

| 接続先 | 方式 |
|---|---|
| Ollama | ローカル `/api/chat`（初期値） |
| OpenAI | Chat Completions |
| Google Gemini | OpenAI互換API |
| Anthropic Claude | Messages API |
| DeepSeek | OpenAI互換API |
| OpenAI互換API | 自分のHTTPSベースURLを指定 |

外部APIは利用可能なモデルIDとAPIキーを入力し、「接続をテスト」でJSON応答を確認します。顔の範囲推定には画像入力対応モデルが必要です。接続テストはテキストだけの少量リクエストであり、画像入力対応まで保証しません。互換APIがJSONモードを受け付けない場合は設定をオフにできます。返されたJSONと原文IDは引き続き検証します。

- 演出用APIには脚本・設定・人物の説明を送信。顔推定用APIには生成画像・対象人物の正本画像を送信します。画面に送信先を表示します。
- 画像作画そのものは引き続きMac内のFLUXです。外部LLMを選んでもWebサービス型アプリにはなりません。
- APIキーとLLM接続設定は起動中だけ保持し、作品SQLite・バックアップ・生成履歴へ保存しません。接続先を切り替えるとキーはクリアされます。
- 自動フォールバック、自動リトライはありません。別事業者に無断で原稿を送りません。
- 外部APIはHTTPSのみ。リダイレクトは追従せず、HTTPエラー本文（原稿や認証情報を含み得るもの）は表示・保存しません。
- 外部API利用料は利用者のAPIアカウントへ発生します。外部APIを選んだ処理はオンライン接続が必要です。

接続アダプタはモック応答によるテスト済み。実APIキーを使った課金リクエストとMac実機通信は未検証です。

API仕様: [Gemini互換API](https://ai.google.dev/gemini-api/docs/openai)、[Claude Messages](https://platform.claude.com/docs/en/api/overview)、[DeepSeek](https://api-docs.deepseek.com/)。
