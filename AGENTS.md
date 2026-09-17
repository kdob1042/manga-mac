# 開発エージェントへの入口

最初に [設計・実装計画](docs/IMPLEMENTATION_PLAN.md) を読み、その後 [README](README.md) で現行実装、[Mac導入ガイド](docs/INSTALL_MAC.md) で配布上の制約を確認する。

設計の正本は `docs/IMPLEMENTATION_PLAN.md` 一つとする。別の設計書・スキルへ同じ仕様を転載せず、必要な節を参照する。外部に配布された旧設計や会話中の旧案より、本リポジトリの現行設計を優先する。

Blenderの既存機能はAPI／既存MCP／アドオンで再利用する。新規モジュールを提案する前に、既存機能で代替できない点と必要最小限の接続処理を説明する。責務・データの正本・受入条件は設計書を参照する。

変更はGitHubの最新`dev`を確認し、`dev`から作業ブランチを作ってPRで`dev`へ集約する。GitHubのdefault branchが`main`でも、通常作業の起点には使わない。Cloud Agent等でBase Branchを指定できる場合は`dev`を明示し、指定できない場合も作業開始前に最新`dev`へ切り替える。PRのbaseも通常は`dev`とし、ツール既定値の`main`へ誤ってPRを出さない。

CIもこのブランチ運用に合わせる。非文書変更のPR（`feature/*`・`fix/*`・`docs/*`などから`dev`、および`dev`から`main`）では共通のLinuxチェックを実行する。非文書変更が`dev`へマージされたpushでは、macOSのSwift/Tauri arm64ビルド、Rust回帰試験、DMG生成まで実行する`macOS validation`を完了させる。これが失敗したコミットは`main`へ昇格させず、原因を修正して`dev`へ反映する。`main`へのマージ後は検証を重ねず、配布用DMGだけを作る`macOS release package`を実行する。Actionsの成功と実機での視覚・性能受入は別判定とする。

受け入れ可能なまとまりごとに`dev → main`のPRを作り、必要な検証後に反映する。`main`と`dev`へ直接pushしない。公開・配布上の重大不具合だけ`hotfix/* → main`を許し、反映後は`main → dev`で同期する。ローカルに置いただけで完了としない。コード用リポジトリの更新と、アプリが読み取り専用で扱う原作リポジトリを混同しない。

文書更新、実装、共通テスト、Macビルド、実Blender接続、実機の画像品質・性能検証を別々に報告する。文書のみの変更では既存実装を変更せず、設計上の機能を実装済みと表記しない。


## Issue／PRの着手状態

- 実装可能なIssueは status:ready、未着手の定義はDraft PRが存在しないこととする。
- 着手はIssueへ agent:start ラベルを付けるか、Issueコメントで /start と入力する。GitHub Actionsが最新の dev から issue/<番号>-<短い名前> ブランチとDraft PRを作る。
- Draft PR作成後は status:in-progress、Ready for review後は status:review、devまたはmainへのマージ後は status:done になる。未マージで閉じたPRは status:blocked とする。
- PR本文には Refs #<番号> を残し、実装完了・lint／typecheck／test／build確認後にだけReady for reviewへ変更する。
- 作業ブランチを切っただけでは着手扱いにしない。既存のdev起点・PR経由ルールを優先する。
