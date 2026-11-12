#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
PROJECT_ROOT="$PWD"
NODE_VERSION="${LIBRETV_NODE_VERSION:-$(python3 -c 'import json;print(json.load(open("scripts/runtime-config.json"))["nodeVersion"])')}"
ARCH="$(uname -m)"
case "$ARCH" in arm64) NODE_ARCH=arm64 ;; x86_64) NODE_ARCH=x64 ;; *) echo "Unsupported architecture: $ARCH" >&2; exit 1 ;; esac
ARTIFACT_DIR="$PROJECT_ROOT/build"
RUNTIME_DIR="$ARTIFACT_DIR/runtime/node-v$NODE_VERSION-darwin-$NODE_ARCH"
mkdir -p "$ARTIFACT_DIR/runtime"
if [ ! -x "$RUNTIME_DIR/bin/node" ]; then
  NODE_ARCHIVE="node-v$NODE_VERSION-darwin-$NODE_ARCH.tar.gz"
  curl --fail --location --retry 2 "https://nodejs.org/dist/v$NODE_VERSION/$NODE_ARCHIVE" -o "$ARTIFACT_DIR/runtime/$NODE_ARCHIVE"
  curl --fail --location --retry 2 "https://nodejs.org/dist/v$NODE_VERSION/SHASUMS256.txt" -o "$ARTIFACT_DIR/runtime/SHASUMS256.txt"
  (cd "$ARTIFACT_DIR/runtime"; shasum -a 256 -c <(awk -v name="$NODE_ARCHIVE" '$2 == name {print}' SHASUMS256.txt))
  python3 scripts/verify-upstream.py --archive "$ARTIFACT_DIR/runtime/$NODE_ARCHIVE" --pin-group node --pin-key "$NODE_ARCHIVE"
  tar -xzf "$ARTIFACT_DIR/runtime/$NODE_ARCHIVE" -C "$ARTIFACT_DIR/runtime"
fi
# Check both the archive pin and cached executable before running downloaded Node/npm.
python3 scripts/verify-upstream.py --node-version "$NODE_VERSION" --arch "$NODE_ARCH" > "$ARTIFACT_DIR/verification-node-upstream.json"
export PATH="$RUNTIME_DIR/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export NEXT_TELEMETRY_DISABLED=1
npm ci --ignore-scripts --no-fund
npm run typecheck
node scripts/audit-desktop.mjs --output "$ARTIFACT_DIR/security-audit/project"
LIBRETV_DESKTOP_BUILD=1 DOCKER_BUILD=1 PASSWORD=build-placeholder npm run build
SDK_PATH="$(xcrun --sdk macosx --show-sdk-path)"
# Swift 6.4's swiftbuild backend records the deployment target as its SDK version.
# Use SwiftPM's native backend so AppKit enables the linked SDK's native toolbar design.
swift build --package-path macos -c release --build-system native --sdk "$SDK_PATH" -Xswiftc -warnings-as-errors
APP_PATH="$ARTIFACT_DIR/LibreTV.app"
CORE_VERSION="$(node -p 'require("./package.json").version')"
OFFICIAL_DIR="$ARTIFACT_DIR/official/$CORE_VERSION"
OFFICIAL_ARCHIVE="libretv-$CORE_VERSION-standalone.tar.gz"
if [ ! -f "$OFFICIAL_DIR/Core/server.js" ]; then
  mkdir -p "$OFFICIAL_DIR/Core"
  curl --fail --location --retry 2 "https://github.com/LibreSpark/LibreTV/releases/download/v$CORE_VERSION/$OFFICIAL_ARCHIVE" -o "$OFFICIAL_DIR/$OFFICIAL_ARCHIVE"
  curl --fail --location --retry 2 "https://github.com/LibreSpark/LibreTV/releases/download/v$CORE_VERSION/SHA256SUMS" -o "$OFFICIAL_DIR/SHA256SUMS"
  (cd "$OFFICIAL_DIR"; shasum -a 256 -c SHA256SUMS)
  python3 scripts/verify-upstream.py --archive "$OFFICIAL_DIR/$OFFICIAL_ARCHIVE" --pin-group core --pin-key "$CORE_VERSION"
  tar -xzf "$OFFICIAL_DIR/$OFFICIAL_ARCHIVE" -C "$OFFICIAL_DIR/Core"
fi
python3 scripts/verify-upstream.py --core "$CORE_VERSION" --node-version "$NODE_VERSION" --arch "$NODE_ARCH" > "$ARTIFACT_DIR/verification-upstream.json"
# Preserve the previous generated bundle until all source inputs have been verified.
if [ -e "$APP_PATH" ]; then
  mkdir -p "$ARTIFACT_DIR/previous"
  mv "$APP_PATH" "$ARTIFACT_DIR/previous/LibreTV-$(date +%Y%m%d-%H%M%S).app"
fi
mkdir -p "$APP_PATH/Contents/MacOS" "$APP_PATH/Contents/Resources/Runtime" "$APP_PATH/Contents/Resources/Desktop"
cp macos/.build/release/LibreTVMac "$APP_PATH/Contents/MacOS/LibreTVMac"
strip -S "$APP_PATH/Contents/MacOS/LibreTVMac"
cp "$RUNTIME_DIR/bin/node" "$APP_PATH/Contents/Resources/Runtime/node"
cp macos/Runtime/*.cjs "$APP_PATH/Contents/Resources/Runtime/"
cp scripts/runtime-config.json "$APP_PATH/Contents/Resources/Runtime/runtime-config.json"
cp -R "$OFFICIAL_DIR/Core" "$APP_PATH/Contents/Resources/Core"
cp "$RUNTIME_DIR/LICENSE" "$APP_PATH/Contents/Resources/Runtime/NODE-LICENSE"
cp -R .next/standalone/. "$APP_PATH/Contents/Resources/Desktop/"
cp package-lock.json "$APP_PATH/Contents/Resources/Desktop/desktop-package-lock.json"
mkdir -p "$APP_PATH/Contents/Resources/Desktop/.next"
cp -R .next/static "$APP_PATH/Contents/Resources/Desktop/.next/static"
cp -R public "$APP_PATH/Contents/Resources/Desktop/public"
cp macos/Resources/desktop-bootstrap.js "$APP_PATH/Contents/Resources/desktop-bootstrap.js"
cp public/icons/icon-512.png "$APP_PATH/Contents/Resources/icon.png"
cp LICENSE "$APP_PATH/Contents/Resources/LIBRETV-LICENSE"
node -e 'const fs=require("fs");fs.writeFileSync(process.argv[1],JSON.stringify({adapterVersion:1,dataSchema:3,version:require("./package.json").version,capabilities:["native-save-v1","disk-media-cache-v1","shared-store-v1"]},null,2))' "$APP_PATH/Contents/Resources/Desktop/desktop-adapter.json"
ICONSET="$ARTIFACT_DIR/LibreTV.iconset"
mkdir -p "$ICONSET"
for size in 16 32 128 256 512; do
  sips -z "$size" "$size" public/icons/icon-512.png --out "$ICONSET/icon_${size}x${size}.png" >/dev/null
  twice=$((size * 2)); sips -z "$twice" "$twice" public/icons/icon-512.png --out "$ICONSET/icon_${size}x${size}@2x.png" >/dev/null
done
iconutil -c icns "$ICONSET" -o "$APP_PATH/Contents/Resources/LibreTV.icns"
cp macos/Info.plist "$APP_PATH/Contents/Info.plist"
codesign --force --sign - "$APP_PATH/Contents/Resources/Runtime/node"
codesign --force --deep --sign - "$APP_PATH"
echo "Built local app: $APP_PATH"
