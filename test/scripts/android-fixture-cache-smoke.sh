#!/bin/sh
set -eu

if [ "$#" -ne 2 ] || [ -z "$1" ] || [ -z "$2" ]; then
  echo "Usage: android-fixture-cache-smoke.sh <apk-path> <app-id>" >&2
  exit 2
fi

APK_PATH="$1"
APP_ID="$2"
PROJECT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)"
SESSION="fixture-cache"
SNAPSHOT_PATH="$PROJECT_DIR/test/artifacts/android-fixture-cache-snapshot.json"

cleanup() {
  node --experimental-strip-types "$PROJECT_DIR/src/bin.ts" close --platform android --session "$SESSION" >/dev/null 2>&1 || true
}
trap cleanup EXIT

mkdir -p "$(dirname -- "$SNAPSHOT_PATH")"
node --experimental-strip-types "$PROJECT_DIR/src/bin.ts" install "$APK_PATH" --platform android
node --experimental-strip-types "$PROJECT_DIR/src/bin.ts" open "$APP_ID" --platform android --session "$SESSION" --relaunch
node --experimental-strip-types "$PROJECT_DIR/src/bin.ts" snapshot -i --platform android --session "$SESSION" --json > "$SNAPSHOT_PATH"
node "$PROJECT_DIR/test/scripts/assert-android-fixture-snapshot.mjs" "$SNAPSHOT_PATH" "$APP_ID"
