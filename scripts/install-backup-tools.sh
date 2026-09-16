#!/bin/sh
# Fixed official standalone executables; no package manager, sudo, or curl-pipe-shell.
set -eu
if [ "$#" -ne 1 ]; then echo 'Usage: install-backup-tools.sh EMPTY_DESTINATION' >&2; exit 2; fi
destination=$1
case "$destination" in /*) ;; *) echo "An absolute destination is required" >&2; exit 2 ;; esac
case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) restic_asset=restic_0.19.1_darwin_arm64.bz2; restic_sha=7be0a144ccc377880f294204aa271d76e4b79554b42a751151d425ce6ebac143; rclone_asset=rclone-v1.75.1-osx-arm64.zip; rclone_sha=c61d7a371c62bcbbe882c3423aa4b8bf63485c248dd0f692997b8f0c3f6d0c6f ;;
  Linux-x86_64) restic_asset=restic_0.19.1_linux_amd64.bz2; restic_sha=f415415624dcc452f2a02b8c33641791a8c6d6d3b65bbb3543fcf9a25151585c; rclone_asset=rclone-v1.75.1-linux-amd64.zip; rclone_sha=982b5aa772841168f8e380f139e9e787b2a105403e32b94da8676a0e1c0a13ab ;;
  *) echo 'Supported: Apple Silicon Mac, Linux x86_64 test runner' >&2; exit 2 ;;
esac
mkdir "$destination"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT HUP INT TERM
curl --fail --location --proto '=https' --max-time 180 "https://github.com/restic/restic/releases/download/v0.19.1/$restic_asset" -o "$work/$restic_asset"
curl --fail --location --proto '=https' --max-time 180 "https://downloads.rclone.org/v1.75.1/$rclone_asset" -o "$work/$rclone_asset"
cd "$work"
printf '%s  %s\n%s  %s\n' "$restic_sha" "$restic_asset" "$rclone_sha" "$rclone_asset" > checksums
shasum -a 256 -c checksums
bzip2 -dc "$restic_asset" > "$destination/restic"
unzip -q "$rclone_asset"
cp "${rclone_asset%.zip}/rclone" "$destination/rclone"
chmod 755 "$destination/restic" "$destination/rclone"
"$destination/restic" version
"$destination/rclone" version
