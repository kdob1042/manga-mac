# Manga Mac

GitHubの完成原稿を読み取り専用で取り込み、Blenderの撮影・画像生成・コマ編集をつないで漫画を制作するMacアプリ。Tauri / React / Rust / Swiftを使います。

実装と実機受入は別です。Apple Siliconでの生成品質・ピークメモリ・クリーンインストールは、検証記録の合格条件を確認してください。

| 目的 | 参照先 |
| --- | --- |
| インストール・接続・MacのCodexによる実地確認 | [初回設定](docs/INSTALL_MAC.md) |
| 原稿取込み・編集・動画・書き出し | [使い方](docs/USAGE.md) |
| コードを変更する・検証する | [開発案内](docs/DEVELOPMENT.md) |
| 確定仕様とデータの責務 | [設計](docs/IMPLEMENTATION_PLAN.md)の該当節 |
| 試験結果・未受入条件 | [検証記録](docs/VALIDATION.md) |

```sh
npm ci
npm test
npm run build
npm run dev
```

ブラウザでは組版を確認できます。GitHub認証・Blender・推論はMacのIPC経由です。アプリは原稿を書き換えません。配布用DMGはmainの成功した `macOS release package`、開発変更はdev向けPRを使用します。詳細は開発案内に集約しています。

主な依存: [Tauri 2](https://v2.tauri.app/) / [MediaGenerationKit](https://github.com/drawthingsai/media-generation-kit/tree/8868a9685d9c299816f43ef53efd455ffca437f0)（固定版、LGPLv3。再配布時の義務を維持）。
