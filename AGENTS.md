# 開発エージェントへの入口

最初に [設計・実装計画](docs/IMPLEMENTATION_PLAN.md) を読み、その後 [README](README.md) で現行実装、[Mac導入ガイド](docs/INSTALL_MAC.md) で配布上の制約を確認する。

設計の正本は `docs/IMPLEMENTATION_PLAN.md` 一つとする。別の設計書・スキルへ同じ仕様を転載せず、必要な節を参照する。外部に配布された旧設計や会話中の旧案より、本リポジトリの現行設計を優先する。

Blenderの既存機能はAPI／既存MCP／アドオンで再利用する。新規モジュールを提案する前に、既存機能で代替できない点と必要最小限の接続処理を説明する。責務・データの正本・受入条件は設計書を参照する。

変更はGitHubの最新`dev`を確認し、`dev`から作業ブランチを作ってPRで`dev`へ集約する。GitHubのdefault branchが`main`でも、通常作業の起点には使わない。Cloud Agent等でBase Branchを指定できる場合は`dev`を明示し、指定できない場合も作業開始前に最新`dev`へ切り替える。PRのbaseも通常は`dev`とし、ツール既定値の`main`へ誤ってPRを出さない。

CIもこのブランチ運用に合わせる。PRと`dev` pushでは、変更分類に応じて`web`・`storage`・`llm`・`blender`の該当チェックだけを実行する。共通Rust・依存関係・未知の変更は全系統を実行する。UIのブラウザ試験、実Live連携、実Blenderレンダリング、依存監査はさらに該当変更だけで実行する。native/Tauri変更が`dev`へマージされたpushでは`macOS validation`を実行する。これが失敗したコミットは`main`へ昇格させず、原因を修正して`dev`へ反映する。`main`へのコード変更マージ後は配布用DMGを作る`macOS release package`を実行する。Actionsの成功と実機での視覚・性能受入は別判定とする。

受け入れ可能なまとまりごとに`dev → main`のPRを作り、必要な検証後に反映する。`main`と`dev`へ直接pushしない。公開・配布上の重大不具合だけ`hotfix/* → main`を許し、main固有の修正は必要に応じて別PRで`dev`にも反映する。履歴を合わせるだけの`main → dev`同期は通常行わない。ローカルに置いただけで完了としない。コード用リポジトリの更新と、アプリが読み取り専用で扱う原作リポジトリを混同しない。

文書更新、実装、共通テスト、Macビルド、実Blender接続、実機の画像品質・性能検証を別々に報告する。文書のみの変更では既存実装を変更せず、設計上の機能を実装済みと表記しない。


## Issue／PRの着手状態

- 実装可能なIssueは status:ready、未着手の定義はDraft PRが存在しないこととする。
- 着手はIssueへ agent:start ラベルを付けるか、Issueコメントで /start と入力する。GitHub Actionsが最新の dev から issue/<番号>-<短い名前> ブランチとDraft PRを作る。
- Draft PR作成後は status:in-progress、Ready for review後は status:review、devまたはmainへのマージ後は status:done になる。未マージで閉じたPRは status:blocked とする。
- PR本文には Refs #<番号> を残し、実装完了・lint／typecheck／test／build確認後にだけReady for reviewへ変更する。
- 作業ブランチを切っただけでは着手扱いにしない。既存のdev起点・PR経由ルールを優先する。

## Issue／PRの部分実装と残件

詳細な手順は [Issue・PRの残件運用](docs/ISSUE_WORKFLOW.md) を参照する。

- Issueを部分実装する場合は、マージ前に受入条件を「今回完了するもの」と「未完了のもの」に分ける。
- 独立して実装できる未完了項目は、実装可能な単位の別Issueへ切り出す。残件Issueには目的、範囲、受入条件、依存関係を記載し、元Issueと実装PRから相互リンクする。
- PR本文では、Issue全体を完了する場合だけ `Closes #<番号>`（または `Fixes`／`Resolves`）を使う。部分実装・調査・準備・関連対応は `Refs #<番号>` とする。
- 元Issueの必須受入条件が残っている場合、残件Issueを作っただけで元Issueを閉じない。PRのマージ後も、元Issue、残件Issue、PR、statusラベルの状態を確認する。
- 「CI成功」「実装済み」「実機受入済み」を同じ完了状態として扱わない。未検証の条件は残件として明記する。

