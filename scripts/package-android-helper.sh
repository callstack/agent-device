#!/bin/sh
set -eu

HELPER="${AGENT_DEVICE_ANDROID_HELPER:-}"
if [ -z "$HELPER" ]; then
  HELPER="${1:-}"
  [ "$#" -ge 1 ] && shift
fi

# Only the snapshot helper publishes a GitHub release asset, so only it takes a release
# tag and only it gets a releaseTag/apkUrl/checksumName manifest.
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

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
node "$SCRIPT_DIR/release-version.mjs" asset-tag "v$VERSION"
if [ "$HAS_RELEASE_TAG" = 1 ]; then
  node "$SCRIPT_DIR/release-version.mjs" asset-tag "$RELEASE_TAG"
fi

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

    node - "$VERSION" "$RELEASE_TAG" "$APK_BASENAME" "$APK_URL" "$SHA256" "$CHECKSUM_BASENAME" "$PACKAGE_NAME" "$VERSION_CODE" "$MIN_SDK" "$TARGET_SDK" > "$MANIFEST_PATH" <<'NODE'
const [version, releaseTag, assetName, apkUrl, sha256, checksumName, packageName, versionCode, minSdk, targetSdk] = process.argv.slice(2);
console.log(JSON.stringify({ name: 'android-snapshot-helper', version, releaseTag, assetName, apkUrl: apkUrl || null, sha256, checksumName, packageName, versionCode: Number(versionCode), instrumentationRunner: `${packageName}/.SnapshotInstrumentation`, minSdk: Number(minSdk), targetSdk: Number(targetSdk), outputFormat: 'uiautomator-xml', statusProtocol: 'android-snapshot-helper-v1' }, null, 2));
NODE
    ;;
  ime)
    node - "$VERSION" "$APK_BASENAME" "$SHA256" "$PACKAGE_NAME" "$VERSION_CODE" > "$MANIFEST_PATH" <<'NODE'
const [version, assetName, sha256, packageName, versionCode] = process.argv.slice(2);
console.log(JSON.stringify({ name: 'android-ime-helper', version, assetName, sha256, packageName, versionCode: Number(versionCode), serviceComponent: `${packageName}/.TestInputMethodService`, broadcastProtocol: 'android-ime-helper-v1' }, null, 2));
NODE
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
