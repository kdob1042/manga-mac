#!/bin/bash
set -euo pipefail
# Separate, unsigned integration build. No model weights or second image runtime.
repo_root="$(cd "$(dirname "$0")/../.." && pwd)"
build_root="${1:?Pass an empty build directory}"
mkdir -p "$build_root"
build_root="$(cd "$build_root" && pwd)"
git clone https://github.com/robbietilton/Compositor.git "$build_root/upstream"
git -C "$build_root/upstream" checkout --detach c39da13b5db11bc8678ec04a7a748e1e0a589244
python3 "$repo_root/integrations/compositor/prepare.py" "$build_root/upstream"
xcodebuild -project "$build_root/upstream/Compositor.xcodeproj" -scheme Compositor -configuration Release -derivedDataPath "$build_root/derived" CODE_SIGNING_ALLOWED=NO PRODUCT_BUNDLE_IDENTIFIER=com.manga-mac.compositor build
printf 'Built: %s\n' "$build_root/derived/Build/Products/Release/Compositor.app"
