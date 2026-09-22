# Project自動同期

対象は `kdob1042/manga-mac`、`kdob1042/live-manga` と [Development Control](https://github.com/users/kdob1042/projects/1)。Issue / PRを正本に、IssueカードのStatusを一方向に同期する。`status:*`・`agent:started`は廃止し、同期成功後に除去する。`agent:start`はActions内部マーカーで、手動操作しない。

## 着手・完了

1. Issueを作るとProjectへ追加される。
2. 実装前にIssueへ `/start` だけのコメントを投稿する。Actionsがdevから空コミット付きDraft PRを作り、同じ実行内でProjectを更新する。関連PRがあれば再利用する。
3. 作成されたPR / ブランチで実装する。PRの `Refs` / `Closes`、残件の `Parent:` は[Issue運用](ISSUE_WORKFLOW.md)に従う。
4. dev / mainへの完了PRマージ後、同期がIssueを閉じてDoneにする。別の関連open PRがあれば閉じない。部分実装は `Refs` のPRマージと残件Issueを確認し、元をDone、残件をTodoにする。残件がなければ元は開いたままNeeds attentionにする。

| 実態 | Status |
| --- | --- |
| open Issue、未着手 | Todo |
| 関連open PRあり（Draft含む） | In Progress |
| 現在のPR先端でCI失敗・キャンセル・変更要求 | Needs attention |
| 着手後のPR作成失敗、または部分PR終了後に残件なし | Needs attention |
| Issue closed | Done |

CI再実行・承認・PR再開・後続PR作成では現在の状態を再計算し、古いコミットのCI失敗を引き継がない。PRマージだけをDoneの根拠にしない。

対応付けはPR本文の明示参照と管理ブランチ名を使い、Developmentリンクだけに依存しない。他repo・コード例・コメント内の参照、フォークPRからの権限付き操作は対象外。再開Issueを過去のPRで閉じ直さず、導入前のマージから遡及クローズしない。

## 設定・復旧

- 両repoのRepository secret `PROJECTS_TOKEN` にIssue / PR / Contents書込み、Actions読取り、ユーザーProject書込み権限が必要。`GITHUB_TOKEN`へ代替しない。値をログ・Issueへ書かない。
- `Automation checks` はロジックとProject権限・Statusの読取りを検査する。更新可否は同期実行でも検査する。
- `Start issue with draft PR` / `Sync project status` は **default branchのコード** で動く。devで検証後、mainにもPRで反映する。
- Projectの `Auto-close issue`（Done→Issue closed）は無効にする。他repoのauto-addは変えない。手動Statusは次の同期で正本へ戻る。
- Issue / PR / CI / レビューイベントと毎時17分の定期処理で、現在の状態に差分がある時だけ更新する。GitHubのキュー遅延はあり得る。
- 失敗時はActionsログを確認する。Tokenの期限・権限を直し、管理者が `Sync project status → Run workflow` を `dry_run=true` で確認後、falseで反映する。開始失敗は `/start` を再投稿する。
- 権限失効時はProjectへ失敗を表示できないため、Actions通知を確認する。同期失敗を成功扱いにしない。

対象はopen IssueとProjectに既存の自repo Issue。過去のclosed Issueを新規投入せず、アーカイブを復元・重複追加しない。他repoのカードを変えず、`Parent:`は同一repoの明示的な残件移管に限定する。

テスト: `node --test .github/scripts/project-sync.test.cjs`。
