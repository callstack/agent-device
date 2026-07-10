#!/bin/sh
set -eu

if [ "$#" -ne 2 ]; then
  echo "Usage: $0 <version> <output-dir>" >&2
  exit 1
fi

VERSION="$1"
OUTPUT_DIR="$2"
PROJECT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
PACKAGE_NAME="com.callstack.agentdevice.imehelper"
SERVICE_COMPONENT="$PACKAGE_NAME/.TestInputMethodService"
APK_BASENAME="agent-device-android-ime-helper-$VERSION.apk"
CHECKSUM_BASENAME="$APK_BASENAME.sha256"
MANIFEST_BASENAME="agent-device-android-ime-helper-$VERSION.manifest.json"

write_github_output() {
  if [ -n "${GITHUB_OUTPUT:-}" ]; then
    printf '%s\n' "$1" >> "$GITHUB_OUTPUT"
  fi
}

mkdir -p "$OUTPUT_DIR"

BUILD_OUTPUT="$(sh "$PROJECT_DIR/scripts/build-android-ime-helper.sh" "$VERSION" "$OUTPUT_DIR")"
APK_PATH="$(printf '%s\n' "$BUILD_OUTPUT" | awk -F= '$1 == "apk" { print $2 }')"
VERSION_CODE="$(printf '%s\n' "$BUILD_OUTPUT" | awk -F= '$1 == "version_code" { print $2 }')"
CHECKSUM_PATH="$OUTPUT_DIR/$CHECKSUM_BASENAME"
MANIFEST_PATH="$OUTPUT_DIR/$MANIFEST_BASENAME"

if [ ! -f "$APK_PATH" ]; then
  echo "Helper APK was not created at $APK_PATH" >&2
  exit 1
fi

SHA256="$(shasum -a 256 "$APK_PATH" | awk '{print $1}')"
printf '%s  %s\n' "$SHA256" "$APK_BASENAME" > "$CHECKSUM_PATH"

{
  printf '{\n'
  printf '  "name": "android-ime-helper",\n'
  printf '  "version": "%s",\n' "$VERSION"
  printf '  "assetName": "%s",\n' "$APK_BASENAME"
  printf '  "sha256": "%s",\n' "$SHA256"
  printf '  "packageName": "%s",\n' "$PACKAGE_NAME"
  printf '  "versionCode": %s,\n' "$VERSION_CODE"
  printf '  "serviceComponent": "%s",\n' "$SERVICE_COMPONENT"
  printf '  "broadcastProtocol": "android-ime-helper-v1"\n'
  printf '}\n'
} > "$MANIFEST_PATH"

write_github_output "apk_path=$APK_PATH"
write_github_output "checksum_path=$CHECKSUM_PATH"
write_github_output "manifest_path=$MANIFEST_PATH"
write_github_output "apk_name=$APK_BASENAME"
write_github_output "sha256=$SHA256"
write_github_output "package_name=$PACKAGE_NAME"
write_github_output "version_code=$VERSION_CODE"

printf 'apk=%s\n' "$APK_PATH"
printf 'checksum=%s\n' "$CHECKSUM_PATH"
printf 'manifest=%s\n' "$MANIFEST_PATH"
