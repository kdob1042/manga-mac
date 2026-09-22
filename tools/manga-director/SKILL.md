---
name: manga-director-loop
description: Run bounded script and virtual manga-plan improvement outside the manga-mac application.
---

# 外部 Manga Director の実行

1. 同ディレクトリのREADMEを読み、作品Repoの既存正本と対象範囲を特定する。アプリ起動・SQLite編集・生成画像を前提にしない。
2. 利用するhost adapter、#253の共有validator、#255の1回生成、設定済みのモデルと送信許可を確認する。実装が欠けている場合は#265の未接続として報告し、fixtureを実AIとして使わない。
3. 同版の原稿・人物設定・前後文脈から一時snapshot入力を作る。正本manifestを増やさず、対象外sceneはread-onlyとする。秘密情報やAPIキーを入力へ混ぜない。
4. 原稿が指定するコマ数を機械的に埋めるのではなく、既存#255の能力でページ・コマの計画を作る。脚本の追加が不要なら追加しない。
5. 信頼済みadapterを明示し、CLIを新しい実行ディレクトリに対して実行する。回数と予算を無断で増やさず、別providerへ切り替えない。
6. `result.json`のstopReason、selectedIteration、提案と採否、最終差分を確認する。完了receiptがない場合や外部要求の結果が不明な場合は、自動再開・再送しない。
7. ユーザーへ「どこに何を足す/直すか、理由、ページ・コマへの影響、未解決事項」を提示する。workingでの採用と、人による正本への採用を混同しない。
8. 原稿正本への書き戻し・commit/pushはこのSkillでは実行しない。承認後の正本反映とSourceRef再解決を経てから、共有v2の検証済み成果物を#257の入口へ渡す。

機械検査、fixtureでの制御試験、実LLM実行、漫画としての品質、アプリ取込を別々に報告する。Skillを読んだことやJSONを生成したことだけで連携完了としない。
