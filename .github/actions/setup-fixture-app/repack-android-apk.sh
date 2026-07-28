#!/usr/bin/env bash
set -euo pipefail

APK="${1:?source APK is required}"
OUT="${2:?output APK is required}"
SDK_ROOT="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-/usr/local/lib/android/sdk}}"
BUILD_TOOLS="$SDK_ROOT/build-tools/36.0.0"
if [ ! -x "$BUILD_TOOLS/aapt" ] || [ ! -x "$BUILD_TOOLS/apksigner" ]; then
  echo "::error::Android build tools were not found at $BUILD_TOOLS." >&2
  exit 1
fi
rm -rf "$(dirname "$OUT")"; mkdir -p "$(dirname "$OUT")"
# repack-app signs APKs with its packaged Android debug key when no key options
# are supplied. That is the same installable debug-signing contract used by the
# generated Expo Release build, and avoids carrying a key through artifacts.
pnpm --dir examples/test-app exec repack-app \
  --platform android \
  --source-app "$APK" \
  --output "$OUT" \
  --android-build-tools-dir "$BUILD_TOOLS" \
  --js-bundle-only
if ! "$BUILD_TOOLS/apksigner" verify --verbose "$OUT"; then
  echo "::error::Repacked APK has an invalid signature." >&2
  exit 1
fi

apk_package_id() {
  local badging
  badging="$("$BUILD_TOOLS/aapt" dump badging "$1")" || return 1
  printf '%s\n' "$badging" | sed -n "s/^package: name='\([^']*\)'.*/\1/p"
}

apk_signer_digest() {
  local certificate
  certificate="$("$BUILD_TOOLS/apksigner" verify --print-certs "$1")" || return 1
  printf '%s\n' "$certificate" | sed -n 's/^Signer #1 certificate SHA-256 digest: //p'
}

SOURCE_APP_ID="$(apk_package_id "$APK")" || SOURCE_APP_ID=""
OUTPUT_APP_ID="$(apk_package_id "$OUT")" || OUTPUT_APP_ID=""
if [ -z "$SOURCE_APP_ID" ] || [ "$SOURCE_APP_ID" != "$OUTPUT_APP_ID" ]; then
  echo "::error::Repacked APK did not preserve package id $SOURCE_APP_ID." >&2
  exit 1
fi
SOURCE_CERTIFICATE="$(apk_signer_digest "$APK")" || SOURCE_CERTIFICATE=""
OUTPUT_CERTIFICATE="$(apk_signer_digest "$OUT")" || OUTPUT_CERTIFICATE=""
if [ -z "$SOURCE_CERTIFICATE" ] || [ "$SOURCE_CERTIFICATE" != "$OUTPUT_CERTIFICATE" ]; then
  echo "::error::Repacked APK did not preserve the source signing certificate." >&2
  exit 1
fi
