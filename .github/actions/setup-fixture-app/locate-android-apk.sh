#!/usr/bin/env bash
set -euo pipefail

DEST="${1:?fixture directory is required}"
SDK_ROOT="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-/usr/local/lib/android/sdk}}"
BUILD_TOOLS="$SDK_ROOT/build-tools/36.0.0"

APKS=()
while IFS= read -r apk; do
  APKS+=("$apk")
done < <(find "$DEST" -maxdepth 1 -type f -name '*.apk' -print)
if [ "${#APKS[@]}" -ne 1 ]; then
  echo "::error::Expected exactly one fixture APK at $DEST; found ${#APKS[@]}." >&2
  exit 1
fi
if [ ! -x "$BUILD_TOOLS/aapt" ]; then
  echo "::error::Android build tools were not found at $BUILD_TOOLS." >&2
  exit 1
fi
if ! BADGING="$("$BUILD_TOOLS/aapt" dump badging "${APKS[0]}")"; then
  echo "::error::Could not inspect fixture APK ${APKS[0]}; it may be malformed." >&2
  exit 1
fi
APP_ID="$(printf '%s\n' "$BADGING" | sed -n "s/^package: name='\([^']*\)'.*/\1/p")"
if [ -z "$APP_ID" ]; then
  echo "::error::Fixture APK ${APKS[0]} has no readable package id." >&2
  exit 1
fi
echo "app-path=${APKS[0]}" >> "$GITHUB_OUTPUT"
echo "app-id=$APP_ID" >> "$GITHUB_OUTPUT"
echo "fixture APK: $(basename "${APKS[0]}") ($APP_ID)"
