#!/bin/sh
set -eu

HELPER="${AGENT_DEVICE_ANDROID_HELPER:-}"
if [ -z "$HELPER" ]; then
  HELPER="${1:-}"
  [ "$#" -ge 1 ] && shift
fi

# Only the snapshot helper publishes a GitHub release asset, so only it takes a release
# tag and only it gets a releaseTag/apkUrl/checksumName/installArgs manifest.
case "$HELPER" in
  snapshot) HAS_RELEASE_TAG=1 ;;
  ime) HAS_RELEASE_TAG=0 ;;
  *)
    echo "Unknown Android helper: '$HELPER' (expected 'snapshot' or 'ime')" >&2
    exit 1
    ;;
esac

if [ "$HAS_RELEASE_TAG" = 1 ]; then
  if [ "$#" -ne 3 ]; then
    echo "Usage: AGENT_DEVICE_ANDROID_HELPER=snapshot $0 <version> <release-tag> <output-dir>" >&2
    echo "   or: $0 snapshot <version> <release-tag> <output-dir>" >&2
    exit 1
  fi
  VERSION="$1"
  RELEASE_TAG="$2"
  OUTPUT_DIR="$3"
else
  if [ "$#" -ne 2 ]; then
    echo "Usage: AGENT_DEVICE_ANDROID_HELPER=ime $0 <version> <output-dir>" >&2
    echo "   or: $0 ime <version> <output-dir>" >&2
    exit 1
  fi
  VERSION="$1"
  OUTPUT_DIR="$2"
  RELEASE_TAG=""
fi

PROJECT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"

case "$HELPER" in
  snapshot) PACKAGE_NAME="com.callstack.agentdevice.snapshothelper" ;;
  ime) PACKAGE_NAME="com.callstack.agentdevice.imehelper" ;;
esac

MIN_SDK=23
TARGET_SDK=36
APK_BASENAME="agent-device-android-$HELPER-helper-$VERSION.apk"
CHECKSUM_BASENAME="$APK_BASENAME.sha256"
MANIFEST_BASENAME="agent-device-android-$HELPER-helper-$VERSION.manifest.json"
GITHUB_SERVER="${GITHUB_SERVER_URL:-https://github.com}"
REPOSITORY="${GITHUB_REPOSITORY:-}"

write_github_output() {
  if [ -n "${GITHUB_OUTPUT:-}" ]; then
    printf '%s\n' "$1" >> "$GITHUB_OUTPUT"
  fi
}

mkdir -p "$OUTPUT_DIR"

BUILD_OUTPUT="$(AGENT_DEVICE_ANDROID_HELPER="$HELPER" sh "$PROJECT_DIR/scripts/build-android-helper.sh" "$VERSION" "$OUTPUT_DIR")"
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

case "$HELPER" in
  snapshot)
    if [ -n "$REPOSITORY" ]; then
      APK_URL="$GITHUB_SERVER/$REPOSITORY/releases/download/$RELEASE_TAG/$APK_BASENAME"
    else
      APK_URL=""
    fi

    {
      printf '{\n'
      printf '  "name": "android-snapshot-helper",\n'
      printf '  "version": "%s",\n' "$VERSION"
      printf '  "releaseTag": "%s",\n' "$RELEASE_TAG"
      printf '  "assetName": "%s",\n' "$APK_BASENAME"
      if [ -n "$APK_URL" ]; then
        printf '  "apkUrl": "%s",\n' "$APK_URL"
      else
        printf '  "apkUrl": null,\n'
      fi
      printf '  "sha256": "%s",\n' "$SHA256"
      printf '  "checksumName": "%s",\n' "$CHECKSUM_BASENAME"
      printf '  "packageName": "%s",\n' "$PACKAGE_NAME"
      printf '  "versionCode": %s,\n' "$VERSION_CODE"
      printf '  "instrumentationRunner": "%s/.SnapshotInstrumentation",\n' "$PACKAGE_NAME"
      printf '  "minSdk": %s,\n' "$MIN_SDK"
      printf '  "targetSdk": %s,\n' "$TARGET_SDK"
      printf '  "outputFormat": "uiautomator-xml",\n'
      printf '  "statusProtocol": "android-snapshot-helper-v1",\n'
      printf '  "installArgs": ["install", "-r", "-t"]\n'
      printf '}\n'
    } > "$MANIFEST_PATH"
    ;;
  ime)
    {
      printf '{\n'
      printf '  "name": "android-ime-helper",\n'
      printf '  "version": "%s",\n' "$VERSION"
      printf '  "assetName": "%s",\n' "$APK_BASENAME"
      printf '  "sha256": "%s",\n' "$SHA256"
      printf '  "packageName": "%s",\n' "$PACKAGE_NAME"
      printf '  "versionCode": %s,\n' "$VERSION_CODE"
      printf '  "serviceComponent": "%s/.TestInputMethodService",\n' "$PACKAGE_NAME"
      printf '  "broadcastProtocol": "android-ime-helper-v1"\n'
      printf '}\n'
    } > "$MANIFEST_PATH"
    ;;
esac

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
