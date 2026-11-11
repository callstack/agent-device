#!/bin/sh
set -eu

if [ "$#" -ne 3 ]; then
  echo "Usage: $0 <version> <release-tag> <output-dir>" >&2
  exit 1
fi

VERSION="$1"
RELEASE_TAG="$2"
OUTPUT_DIR="$3"

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
node "$SCRIPT_DIR/release-version.mjs" asset-tag "v$VERSION"
node "$SCRIPT_DIR/release-version.mjs" asset-tag "$RELEASE_TAG"

DERIVED_PATH="${AGENT_DEVICE_IOS_RUNNER_DERIVED_PATH:-$HOME/.agent-device/apple-runner/derived}"
PRODUCTS_DIR="$DERIVED_PATH/Build/Products"
EXPECTED_RUNNER_BUNDLE_ID="${AGENT_DEVICE_IOS_RUNNER_RELEASE_BUNDLE_ID:-}"
ARCHIVE_BASENAME="agent-device-ios-runner-$VERSION.app.tar.gz"
CHECKSUM_BASENAME="$ARCHIVE_BASENAME.sha256"
MANIFEST_BASENAME="agent-device-ios-runner-$VERSION.manifest.json"
GITHUB_SERVER="${GITHUB_SERVER_URL:-https://github.com}"
REPOSITORY="${GITHUB_REPOSITORY:-}"

if [ ! -d "$PRODUCTS_DIR" ]; then
  echo "Runner build products not found at $PRODUCTS_DIR" >&2
  exit 1
fi

read_plist_value() {
  plist_path="$1"
  key="$2"
  /usr/libexec/PlistBuddy -c "Print :$key" "$plist_path" 2>/dev/null || true
}

write_github_output() {
  if [ -n "${GITHUB_OUTPUT:-}" ]; then
    printf '%s\n' "$1" >> "$GITHUB_OUTPUT"
  fi
}

resolve_runner_xctestrun_path() {
  find "$PRODUCTS_DIR" -maxdepth 1 -name '*iphonesimulator*.xctestrun' | sort | head -n 1
}

resolve_xctestrun_runner_app_path() {
  xctestrun_path="$1"
  test_host_path="$(
    read_plist_value "$xctestrun_path" \
      'TestConfigurations:0:TestTargets:0:TestHostPath'
  )"

  case "$test_host_path" in
    __TESTROOT__/*)
      printf '%s\n' "$PRODUCTS_DIR/${test_host_path#__TESTROOT__/}"
      ;;
    *)
      printf '%s\n' "$test_host_path"
      ;;
  esac
}

RUNNER_XCTESTRUN_PATH="$(resolve_runner_xctestrun_path)"
if [ -z "$RUNNER_XCTESTRUN_PATH" ]; then
  echo "Unable to locate iphonesimulator xctestrun under $PRODUCTS_DIR" >&2
  exit 1
fi

RUNNER_APP_PATH="$(resolve_xctestrun_runner_app_path "$RUNNER_XCTESTRUN_PATH")"
if [ ! -d "$RUNNER_APP_PATH" ]; then
  echo "Unable to locate simulator runner app referenced by $RUNNER_XCTESTRUN_PATH" >&2
  exit 1
fi

mkdir -p "$OUTPUT_DIR"

STAGE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/agent-device-ios-runner.XXXXXX")"
cleanup() {
  rm -rf "$STAGE_DIR"
}
trap cleanup EXIT INT TERM

STAGED_APP_PATH="$STAGE_DIR/agent-device-ios-runner-$VERSION.app"
ARCHIVE_PATH="$OUTPUT_DIR/$ARCHIVE_BASENAME"
CHECKSUM_PATH="$OUTPUT_DIR/$CHECKSUM_BASENAME"
MANIFEST_PATH="$OUTPUT_DIR/$MANIFEST_BASENAME"
RUNNER_BUNDLE_ID="$(read_plist_value "$RUNNER_APP_PATH/Info.plist" CFBundleIdentifier)"
APP_NAME="$(read_plist_value "$RUNNER_APP_PATH/Info.plist" CFBundleName)"
if [ -z "$APP_NAME" ]; then
  APP_NAME="$(basename "$RUNNER_APP_PATH" .app)"
fi
if [ -n "$EXPECTED_RUNNER_BUNDLE_ID" ] && [ "$RUNNER_BUNDLE_ID" != "$EXPECTED_RUNNER_BUNDLE_ID" ]; then
  echo "Runner bundle id $RUNNER_BUNDLE_ID did not match expected $EXPECTED_RUNNER_BUNDLE_ID" >&2
  exit 1
fi

ditto "$RUNNER_APP_PATH" "$STAGED_APP_PATH"
# Limrun hosts run XCTest with Xcode 27, which loads XCTest from its own platform directory. A runner
# that embeds XCTest.framework comes from an older Xcode, and its test host crashes there.
if [ -d "$STAGED_APP_PATH/Frameworks/XCTest.framework" ]; then
  echo "The runner app embeds XCTest.framework. Build the simulator runner with Xcode 27 (set DEVELOPER_DIR to an Xcode 27 install): Limrun hosts load XCTest from their own Xcode 27, and an older embedded copy crashes the test host." >&2
  exit 1
fi
rm -f "$ARCHIVE_PATH"
(
  cd "$STAGE_DIR"
  COPYFILE_DISABLE=1 tar -czf "$ARCHIVE_PATH" "$(basename "$STAGED_APP_PATH")"
)

SHA256="$(shasum -a 256 "$ARCHIVE_PATH" | awk '{print $1}')"
printf '%s  %s\n' "$SHA256" "$ARCHIVE_BASENAME" > "$CHECKSUM_PATH"

if [ -n "$REPOSITORY" ]; then
  ARCHIVE_URL="$GITHUB_SERVER/$REPOSITORY/releases/download/$RELEASE_TAG/$ARCHIVE_BASENAME"
else
  ARCHIVE_URL=""
fi

node - "$VERSION" "$RELEASE_TAG" "$ARCHIVE_BASENAME" "$ARCHIVE_URL" "$SHA256" "$CHECKSUM_BASENAME" "$RUNNER_BUNDLE_ID" "$APP_NAME" > "$MANIFEST_PATH" <<'NODE'
const [version, release_tag, asset_name, assetUrl, sha256, checksum_name, bundle_id, bundle_name] = process.argv.slice(2);
console.log(JSON.stringify({ version, release_tag, asset_name, asset_url: assetUrl || null, sha256, checksum_name, bundle_id, bundle_name, platform_target: 'iphonesimulator', archive_format: 'tar.gz' }, null, 2));
NODE

write_github_output "runner_app_path=$RUNNER_APP_PATH"
write_github_output "xctestrun_path=$RUNNER_XCTESTRUN_PATH"
write_github_output "archive_path=$ARCHIVE_PATH"
write_github_output "checksum_path=$CHECKSUM_PATH"
write_github_output "manifest_path=$MANIFEST_PATH"
write_github_output "archive_name=$ARCHIVE_BASENAME"
write_github_output "sha256=$SHA256"
write_github_output "bundle_id=$RUNNER_BUNDLE_ID"

printf 'archive=%s\n' "$ARCHIVE_PATH"
printf 'checksum=%s\n' "$CHECKSUM_PATH"
printf 'manifest=%s\n' "$MANIFEST_PATH"
