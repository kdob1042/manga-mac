#!/bin/sh
set -eu
# Fixed official release, checksum from GitHub release asset metadata.
install_dir="$1"
mkdir -p "$install_dir"
curl --fail --location --proto '=https' --retry 2 -o "$install_dir/ollama.tar.zst" https://github.com/ollama/ollama/releases/download/v0.34.1/ollama-linux-amd64.tar.zst
printf '%s  %s\n' f361dc3992ec07e4ad429f4bb2d10d4663ba2c295f9a9a688c7d52f4ba650034 "$install_dir/ollama.tar.zst" | sha256sum --check
tar --zstd -xf "$install_dir/ollama.tar.zst" -C "$install_dir"
rm "$install_dir/ollama.tar.zst"
printf '%s\n' "$install_dir/bin" >> "$GITHUB_PATH"
