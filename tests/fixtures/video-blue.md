# 人工MP4 fixture

`video-blue.mp4.base64`はテストだけに使う1秒・32×32・10fps・H.264/yuv420p・無音の青一色クリップ。ユーザー素材や生成API出力ではない。2026-09-16、FFmpegで作成しffprobeでcodec/寸法/尺/1838 bytesを確認した。

再生成:

```sh
ffmpeg -f lavfi -i color=c=blue:s=32x32:r=10 -t 1 -an -c:v libx264 -pix_fmt yuv420p -movflags +faststart video-blue.mp4
```

バイナリをbase64テキストとしてリポジトリへ保存しているが、アプリの作品JSONへ動画bytesを入れる仕様ではない。native storage試験がdecodeしてReadストリームを渡す。生成AIの機能・品質、Tauriの動画再生の検証とは区別する。
