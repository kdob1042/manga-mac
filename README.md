# Manga Mac

GitHubの原稿を読み取り専用で取り込み、コマ割り・参照付き作画・文字配置・出力まで進めるMacアプリです。通常は2Dで制作し、構図調整にはBlender、レイヤー編集にはCompositorを使えます。

**原稿を選ぶ → ネームを確定 → 作画 → 仕上げ → 書き出す。** 原文・旧画像・採用履歴を保持し、再生成した候補は確認して採用します。

| 目的 | 参照先 |
| --- | --- |
| インストール・接続 | [初回設定](docs/INSTALL_MAC.md) |
| 取込みから完成・公開用出力まで | [使い方](docs/USAGE.md) |
| コード変更・テスト・ブランチ運用 | [開発案内](docs/DEVELOPMENT.md)（エージェントは [AGENTS.md](AGENTS.md) から） |
| 確定仕様・保存データの責務 | [設計](docs/IMPLEMENTATION_PLAN.md)の該当節 |
| 試験結果・実機の残確認 | [検証記録](docs/VALIDATION.md) |

配布版はmainの成功した `macOS release package` から取得します。実装・CI成功と、Macでの画質・性能・クリーン導入の受入は別です。使用する版の検証記録を確認してください。

開発の最初の確認:

```sh
npm ci
npm test
npm run build
npm run dev
```

ブラウザでは組版を確認できます。GitHub認証・Blender・推論はMacのIPC経由です。開発変更は最新devを起点にdev向けPRへまとめます。

主な依存: [Tauri 2](https://v2.tauri.app/) / [MediaGenerationKit](https://github.com/drawthingsai/media-generation-kit/tree/8868a9685d9c299816f43efd455ffca437f0)（固定版、LGPLv3。再配布時の義務を維持）。
