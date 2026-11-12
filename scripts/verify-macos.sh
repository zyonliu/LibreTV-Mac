#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
NODE_VERSION="$(python3 -c 'import json;print(json.load(open("scripts/runtime-config.json"))["nodeVersion"])')"
export PATH="$PWD/build/runtime/node-v$NODE_VERSION-darwin-arm64/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export LIBRETV_TEST_PROJECT="$PWD"
export LIBRETV_REQUIRE_NETWORK_TESTS=1
export LIBRETV_TEST_PUBLIC_URL="${LIBRETV_TEST_PUBLIC_URL:-https://registry.npmjs.org/-/ping}"
mkdir -p build
npm run typecheck
npm run lint
npm test
node --test tests/*.test.mjs
swift test --package-path macos --build-system native --sdk "$(xcrun --sdk macosx --show-sdk-path)" -Xswiftc -warnings-as-errors
