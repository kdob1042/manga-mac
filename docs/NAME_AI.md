# ネームAIと漫画アプリの責務

ネームAIは「枠の座標を作るAI」ではなく、読者の理解・感情・期待をページ単位で設計する。漫画アプリはAIの判断を検証可能な漫画データへ変換し、原稿保全、配置、作画、文字、履歴、出力を管理する。

## 1. ネームAI

入力は、選択原稿だけでなく同話の前後文脈、人物設定、媒体、既に固定されたページ/コマ。出力は次の順で考える。

1. **Story arc** — 話全体で読者が追う問い、感情曲線、主要payoffを決める。
2. **Beat** — reveal / setup / reaction / action / pause / payoff / transition 等へ原稿範囲を分ける。読者がbeat前後で何を知り、何を期待するかを持つ。
3. **Panel** — beatをどの瞬間で切るか決める。重要度、テンポ、構図意図、人物、原稿範囲を持つ。
4. **Page** — コマをページへ割る。各ページに purpose / entry / exitQuestion を持ち、ページ末で何を残すか決める。
5. **Role** — splash / dominant / standard / inset / sequence を指定する。座標値は決めない。
6. **Self review** — 同じコマ数・同じショット・同じテンポの連続、情報の先出し、見せ場の弱さ、技巧過多を診断する。

「毎Nページに大ゴマ」などのquotaは置かない。技巧を使わない静かなページも有効な出力とする。一方、全ページが似た密度になった場合は意図が説明できなければ再検討する。

## 2. 漫画アプリ

AIを信頼境界にしない。

- sourceRefs、原稿hash、読書順、人物IDを検証する。
- AIの role / weight を既存 layout.version=1 の合法な凸四角形へ決定論的に materialize する。
- 1コマページ、2〜5コマ、必要ならそれ以上を同じデータモデルで扱う。
- 未割当、重複、枠重なり、文字領域、ページ順を検査する。
- 採用、固定、手動変更、Undo/Redo、原稿改訂時の再計画範囲を管理する。
- 作画AI/Blender、文字配置AI、PNG/CBZ/Live Mangaへ確定ネームを渡す。

AIが points を直接返す既存 layout AI は手動の「配置だけ変える」用途に残せるが、初稿の上位設計には使わない。

## 3. 作画AI / Blender

ネームの panel contract を実画像にする。変更可能なのは構図・撮影・画作りであり、sourceRefs、page assignment、台詞、人物IDを変更しない。大ゴマだから高解像度が必要、人物が小さい等の制作条件はここで処理する。

## 4. 文字配置AI

作画後の画像を見て、顔・手・視線・重要物を避けて文字を置く。ネームAIが保持した発話/ナレーションの順序を変えない。文字量が成立しない場合は勝手に要約せず、ネームへ「このコマでは収まらない」と差し戻す。

## 5. Reader QA

ネーム時と完成ページ時の二段階。別モデルである必要はなく、役割を分ける。

- 読み順で迷う
- revealが前ページで見えている
- reaction不足
- 同じサイズ/ショット/テンポの反復
- splash/dominantのインフレ
- page-turn questionが弱い
- スマホ表示で次情報が同時に見えすぎる

指摘だけを返し、自動修正・自動採用しない。

## 6. name-plan/v2

AI出力の正本は意味構造。geometryは派生値。

- workGoal: premise, readerQuestion, emotionalArc, payoffs
- beats[]: id, sourceRefs, function, readerStateBefore, readerStateAfter, tension, tempo
- panels[]: id, sourceRefs, beatIds, characterIds, role, emphasis, shotIntent, prompt
- pages[]: id, purpose, entryBeat, exitQuestion, slots[{panelId, role, weight}]
- diagnostics: deliberateQuiet, repetitionRisk, revealRisk
- materializedLayout: アプリが生成する既存layout.version=1。AI出力とは分離。

v1のpoints入りネームは読み取り互換とし、v2へ移行後も既存データを壊さない。

## 7. 初稿パイプライン

原稿同期 → ネームAI → schema/source検証 → geometry materialize → ユーザー採用 → 作画/Blender → 文字配置 → Reader QA → proof。

外部ネームJSONも「ネームAIの出力をファイル経由で渡したもの」と同じ入口へ入れる。取り込んだネームが既にコマ/ページを持つ場合、通常の「漫画にする」は再度 scene planning / layout planning を行わず、そのネームを制作契約として作画から開始する。

## 8. 現在の実装との差

現状は scene planning と layout planning が別工程で、layout AIは既に作られたpanelのpointsを後から決める。そのためページ末の引きやsplashを話全体から逆算しにくい。さらにreviewDraftの一部はunitIds前提で、sourceRefsを使う外部ネームと不整合がある。

移行では既存の画像生成、Blender、lettering、layout editorを作り直さない。上位のネーム契約とsourceRefs対応を追加し、既存工程を再利用する。
