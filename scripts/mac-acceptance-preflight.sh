#!/bin/sh
# Read-only: the app prints a redacted diagnostic and exits before opening storage.
set -eu
app='/Applications/Manga Mac.app'
executable=''
while [ "$#" -gt 0 ]; do
  case "$1" in
    --app) [ "$#" -ge 2 ] || exit 64; app=$2; shift 2 ;;
    --executable) [ "$#" -ge 2 ] || exit 64; executable=$2; shift 2 ;;
    --help) echo 'Usage: sh mac-acceptance-preflight.sh [--app APP | --executable BINARY]'; exit 0 ;;
    *) echo 'Unknown option. Use --help.' >&2; exit 64 ;;
  esac
done
if [ -z "$executable" ]; then executable="$app/Contents/MacOS/manga-mac"; fi
if [ ! -f "$executable" ] || [ ! -x "$executable" ]; then
  echo '{"status":"NOT_CONFIGURED","check":"app","next":"Install the acceptance-enabled DMG, or specify --executable for a development build."}'
  exit 2
fi
exec "$executable" --acceptance-preflight
