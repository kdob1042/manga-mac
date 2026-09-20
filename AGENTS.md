# 開発エージェントの入口

[README](README.md) → [開発案内](docs/DEVELOPMENT.md)の責務表 → 変更領域のコードと設計節の順に読む。仕様の正本は [IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md) 一つ。古い外部設計より作業ブランチの現行仕様を優先する。

- 最新devを起点とし、Issueへの `/start` で作られたDraft PRを再利用してdevへ集約する。main/devへ直接pushしない。default branchに依存してmainを起点にしない。
- ブランチ昇格・CI・Mac配布は [開発案内](docs/DEVELOPMENT.md)、着手状態と障害復旧は [Project自動同期](docs/PROJECT_AUTOMATION.md) に集約する。Projectを手動でDoneにせず、`status:*`、`agent:start` を手で管理しない。
- PR本文に独立した `Refs #番号`。全受入条件を満たすときだけ `Closes #番号`。部分実装はマージ前に `Parent: #番号` を持つ残件Issueを作る。詳細と設計反映は [Issue運用](docs/ISSUE_WORKFLOW.md)。
- 原稿は読取り専用。本文・固定ID・採用履歴・Undo・Jobと既存保存形式を維持する。
- Blenderの既存機能をAPI/MCP/アドオンで再利用し、新規処理は不足する接続と漫画固有機能に限定する。vendorの契約は同期経路で更新する。
- 文書、実装、共通テスト、Macビルド、実Blender、実機画質・性能を別々に報告する。設計を実装済み、CI成功を実機受入済みと表記しない。

設定や手順を別のAI指示書へ転載しない。変更時は責務表の該当入口と唯一の正本を更新する。
