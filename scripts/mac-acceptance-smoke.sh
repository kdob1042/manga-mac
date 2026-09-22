#!/bin/sh
# Starts the dedicated acceptance UI. No model download or generation on launch.
set -eu
app='/Applications/Manga Mac.app'
executable=''
session=''
while [ "$#" -gt 0 ]; do
  case "$1" in
    --app) [ "$#" -ge 2 ] || exit 64; app=$2; shift 2 ;;
    --executable) [ "$#" -ge 2 ] || exit 64; executable=$2; shift 2 ;;
    --session) [ "$#" -ge 2 ] || exit 64; session=$2; shift 2 ;;
    --help) echo 'Usage: sh mac-acceptance-smoke.sh [--app APP | --executable BINARY] [--session UUID]'; exit 0 ;;
    *) echo 'Unknown option. Use --help.' >&2; exit 64 ;;
  esac
done
developer_executable=$executable
if [ -z "$executable" ]; then executable="$app/Contents/MacOS/manga-mac"; fi
if [ ! -f "$executable" ] || [ ! -x "$executable" ]; then
  echo 'NOT_CONFIGURED: install the acceptance-enabled DMG or specify --executable.' >&2
  exit 2
fi
# Native preflight exits nonzero for a missing required dependency. It never writes.
"$executable" --acceptance-preflight || exit $?
if [ -z "$session" ]; then session=$(uuidgen); fi
# The native parser validates the full UUID before creating any directory.
case "$session" in ''|*[!a-fA-F0-9-]*) echo 'Invalid session UUID.' >&2; exit 64 ;; esac
if [ "${#session}" -ne 36 ]; then echo 'Invalid session UUID.' >&2; exit 64; fi
echo "Acceptance session: $session"
echo "Restart with the same --session $session; completed images are reused."
if [ -n "$developer_executable" ]; then
  exec "$executable" --acceptance-session "$session"
fi
exec /usr/bin/open -n "$app" --args --acceptance-session "$session"
