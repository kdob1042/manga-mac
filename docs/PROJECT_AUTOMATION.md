# Project自動同期

対象は`kdob1042/manga-mac`・`kdob1042/live-manga`と[Development Control](https://github.com/users/kdob1042/projects/1)。IssueとPRを正本にし、IssueカードのProject Statusだけを一方向に同期する。Issue側の`status:*`・`agent:started`は廃止し、同期成功後に既存ラベルを取り除く。`agent:start`は開始要求であり、進捗状態ではない。

| 実態 | Project Status |
| --- | --- |
| open Issue、未着手 | Todo |
| 関連open PRあり（Draft/レビュー待ちを含む） | In Progress |
| 現在のPR先端のCI失敗・キャンセル・変更要求 | Needs attention |
| 着手要求済みだがPR作成失敗／部分PR終了後も残件Issueがない | Needs attention |
| Issue closed | Done |

CI再実行の開始・成功、レビュー承認、PR再オープン・後続PR作成時には現在の実態から再計算する。古いコミットのCI失敗は引き継がない。DoneはPRのmergeだけで付けない。

## 着手と完了

1. Issueを作る。自動でProjectに追加される。
2. **実装前に**エージェントが`agent:start`ラベルを付けるか`/start`だけのコメントを投稿する。Actionsが`dev`から空コミット付きDraft PRを作り、同じ実行内でProjectを更新する。既存関連PRがある場合は再利用する。
3. 作られたPR・ブランチで実装する。人間がIssueラベルとProjectを二重更新する必要はない。
4. PR本文に独立した行で`Refs #123`を記載する。全受入条件を満たすPRだけ`Closes #123`（`Fixes`/`Resolves`も可）に変更する。複数Issueは一行ずつ記載する。他リポジトリ・コード例・コメント内の記述は操作対象にしない。
5. dev/mainへの完了PRマージ後、同期がIssueを閉じてDoneへ更新する。別の関連open PRがある場合は閉じない。部分実装の場合は、先に残件Issueを作り、その本文に独立した行で`Parent: #123`を記載する。同期は`Refs #123`のPRマージと残件Issueの存在を確認して元Issueを閉じ、元カードをDone、残件IssueをTodoにする。残件Issueがなければ元Issueは閉じずNeeds attentionにする。

既存のDevelopmentリンクだけに依存しない。PR本文の明示参照と管理ブランチ名が対応の根拠となる。フォークPRの記述から権限付きIssue操作はしない。再オープンしたIssueを過去の完了PRで閉じ直さない。導入前のマージからIssueを遡及クローズしない。

## 設定と障害復旧

- 両リポジトリの **Repository secret `PROJECTS_TOKEN`** が必要。対象リポジトリのIssue/PR/Contents書込み・Actions読取りと、ユーザーProjectの書込み権限を持つTokenを使う。`GITHUB_TOKEN`への代替はしない。値をログやIssueへ書かない。
- `Automation checks`でロジックテストとProject権限・Status選択肢の読取り検証を行う。実際の更新可否は同期実行でも検証する。
- `Start issue with draft PR`・`Sync project status`は**default branch上のコード**を使う。devにマージするだけでは有効化されない。devで検証後、対象の自動化変更をmainにもPRで反映する。
- Projectの`Auto-close issue`（Done→Issue closed）は無効にする。別リポジトリ向けauto-addは変更しない。カードの手動Statusは次の同期で正本に合わせて戻る。
- Issue/PR/CI/レビューイベントで同期し、毎時17分の定期処理で取りこぼしを修復する。GitHub側のキュー・スケジュール遅延はあり得る。履歴イベントではなく現在の状態を再取得し、変更がある場合だけ書き込む。
- 失敗時はActionsの実行ログを確認する。Token期限切れ・権限不足ならSecretを更新し、`Sync project status`のRun workflowを実行する。まず`dry_run=true`で確認し、反映時はfalseにする。開始失敗は`Start issue with draft PR`の手動実行にIssue番号を指定するか、`/start`を再投稿する。
- 同期失敗は成功扱いにしない。権限が失効した場合、Project自体を更新できないためActionsの失敗が検知箇所となる。Token更新の要否はActions通知で確認する。
- open Issueと既にProjectにある自リポジトリIssueが対象。過去の全closed Issueを新規投入しない。アーカイブ済みカードは復元・重複追加しない。他リポジトリのカードは変更しない。`Parent:`は同一リポジトリの明示的な残件移管にだけ使う。

テスト: `node --test .github/scripts/project-sync.test.cjs`。
