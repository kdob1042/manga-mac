# 開発エージェントへの入口

最初に [設計・実装計画](docs/IMPLEMENTATION_PLAN.md) を読み、その後 [README](README.md) で現行実装、[Mac導入ガイド](docs/INSTALL_MAC.md) で配布上の制約を確認する。

設計の正本は `docs/IMPLEMENTATION_PLAN.md` 一つとする。別の設計書・スキルへ同じ仕様を転載せず、必要な節を参照する。外部に配布された旧設計や会話中の旧案より、本リポジトリの現行設計を優先する。

Blenderの既存機能はAPI／既存MCP／アドオンで再利用する。新規モジュールを提案する前に、既存機能で代替できない点と必要最小限の接続処理を説明する。責務・データの正本・受入条件は設計書を参照する。

変更はGitHubの最新`dev`を確認し、`dev`から作業ブランチを作ってPRで`dev`へ集約する。GitHubのdefault branchが`main`でも、通常作業の起点には使わない。Cloud Agent等でBase Branchを指定できる場合は`dev`を明示し、指定できない場合も作業開始前に最新`dev`へ切り替える。PRのbaseも通常は`dev`とし、ツール既定値の`main`へ誤ってPRを出さない。

CIもこのブランチ運用に合わせる。PRと`dev` pushでは、変更分類に応じて`web`・`storage`・`llm`・`blender`の該当チェックだけを実行する。共通Rust・依存関係・未知の変更は全系統を実行する。UIのブラウザ試験、実Live連携、実Blenderレンダリング、依存監査はさらに該当変更だけで実行する。native/Tauri変更が`dev`へマージされたpushでは`macOS validation`を実行する。これが失敗したコミットは`main`へ昇格させず、原因を修正して`dev`へ反映する。`main`へのコード変更マージ後は配布用DMGを作る`macOS release package`を実行する。Actionsの成功と実機での視覚・性能受入は別判定とする。

受け入れ可能なまとまりごとに`dev → main`のPRを作り、必要な検証後に反映する。`main`と`dev`へ直接pushしない。公開・配布上の重大不具合だけ`hotfix/* → main`を許し、main固有の修正は必要に応じて別PRで`dev`にも反映する。履歴を合わせるだけの`main → dev`同期は通常行わない。ローカルに置いただけで完了としない。コード用リポジトリの更新と、アプリが読み取り専用で扱う原作リポジトリを混同しない。

文書更新、実装、共通テスト、Macビルド、実Blender接続、実機の画像品質・性能検証を別々に報告する。文書のみの変更では既存実装を変更せず、設計上の機能を実装済みと表記しない。


## Issue／PRの着手状態

- 状態の正本はIssueのopen/closedとPR。Projectは自動同期される表示で、`status:*`ラベルを追加・手動管理しない。
- エージェントは実装前にIssueへ`/start`だけのコメントを投稿する。Actionsが内部マーカーを付け、最新`dev`から空コミット付きブランチとDraft PRを作る。既存PRがある場合は再利用する。Draft PR作成を確認してからそのブランチで実装する。`agent:start`を手で付けない。
- Issue作成→Todo、Draftを含むopen PRあり→In Progress、現在のCI失敗・変更要求・PRを閉じたままの未完了Issue→Needs attention、Issue closed→Done。Ready for reviewでもIn Progressのままとする。
- PR本文に独立した行で`Refs #<番号>`を残す。全受入条件を満たす場合だけ`Closes #<番号>`へ変更する。部分実装なら、先に残件Issueを作って本文に`Parent: #<元Issue番号>`を記載し、その後PRをマージする。devへのマージ後、完了PRまたは残件移管を確認した同期処理が元Issueを閉じる。残件Issueなしの部分PRでは閉じない。
- 詳細・障害復旧は[Project自動同期](docs/PROJECT_AUTOMATION.md)を参照。Projectを手でDoneにしてIssueを閉じる逆同期は使わない。既存のdev起点・PR経由ルールを優先する。

## Issue／PRの部分実装と残件

詳細な手順は [Issue・PRの残件運用](docs/ISSUE_WORKFLOW.md) を参照する。

- Issueを部分実装する場合は、マージ前に受入条件を「今回完了するもの」と「未完了のもの」に分ける。
- 独立して実装できる未完了項目は、実装可能な単位の別Issueへ切り出す。残件Issueには目的、範囲、受入条件、依存関係を記載し、元Issueと実装PRから相互リンクする。
- PR本文では、Issue全体を完了する場合だけ `Closes #<番号>`（または `Fixes`／`Resolves`）を使う。部分実装・調査・準備・関連対応は `Refs #<番号>` とする。
- 元Issueの必須受入条件が残る場合は、残件Issueを作り本文に`Parent: #<元Issue番号>`を記載してから元Issueを閉じる。PRのマージ後も、元Issue、残件Issue、PR、Projectの状態を確認する。
- 「CI成功」「実装済み」「実機受入済み」を同じ完了状態として扱わない。未検証の条件は残件として明記する。

<!-- MAC-ENABLER:BEGIN -->
## Shared Codex workflow

このブロックは `kdob1042/mac-enabler` から生成された共通運用部分です。直接編集せず、mac-enablerを更新して同期します。

- 作業開始時に、タスクを `triage`・`implementation`・`architecture`・`review`・`verification`・`documentation`・`incident`・`handoff` のいずれかへ分類し、`.codex/mac-enabler/model-routing.json` のプロファイルを確認する。
- ルートとプロファイルを決めてから実装へ進む。利用ホストがモデルを切り替えられない場合は、選択したプロファイルを報告し、切り替わったと偽らない。
- プロジェクト固有の設計、ブランチ、テスト、データの正本は、このリポジトリの既存 `AGENTS.md` と設計書に従う。共通ブロックはそれらを上書きしない。
- Issue／PRを使う場合、作業状態・検証結果・残件の正本はIssue／PRへ残す。
- `compact`／自動コンパクションの前に、目標、制約、ルート、プロファイル、ブランチ／PR、変更ファイル、テスト結果、残作業、未解決事項、次の一手を引き継ぎパケットとして保存する。
- コンパクション後または別エージェントへ渡された後は、対象リポジトリの `AGENTS.md` と最新の引き継ぎパケットを読み、記録された次の一手から再開する。
- 共通ルールとプロジェクトルールが衝突した場合、プロジェクト固有の事実・受入条件を優先する。解決できない場合は推測で進めず、衝突を報告する。

<!-- MAC-ENABLER:END -->
