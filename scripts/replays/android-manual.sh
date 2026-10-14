#!/bin/sh
set -eu

FIXTURE_APK="$1"
FIXTURE_APP_ID="$2"
SETUP_STARTED_AT="$3"
test -n "$ANDROID_SERIAL"
BOOT_FINISHED_AT="$(date +%s)"

pnpm gate build
pnpm clean:daemon
adb -s "$ANDROID_SERIAL" install -r "$FIXTURE_APK"
node --experimental-strip-types src/bin.ts replay examples/test-app/replays/drag-android.ad --platform android --serial "$ANDROID_SERIAL" --session nightly-android-target-drag --json
pnpm clean:daemon

FULL_STARTED_AT="$(date +%s)"
FULL_STATUS=0
AGENT_DEVICE_ANDROID_E2E=1 AGENT_DEVICE_ANDROID_E2E_TIER=full AGENT_DEVICE_ANDROID_SERIAL="$ANDROID_SERIAL" AGENT_DEVICE_FIXTURE_APP_PATH="$FIXTURE_APK" AGENT_DEVICE_FIXTURE_APP_ID="$FIXTURE_APP_ID" node --experimental-strip-types scripts/node-test-tmpdir.ts --test test/integration/smoke-android-emulator.test.ts || FULL_STATUS=$?
FULL_FINISHED_AT="$(date +%s)"
echo "Android setup before emulator: $((BOOT_FINISHED_AT - SETUP_STARTED_AT))s"
echo "Android full scenario wall time: $((FULL_FINISHED_AT - FULL_STARTED_AT))s"
test "$FULL_STATUS" -eq 0 || exit "$FULL_STATUS"
pnpm gate replay-android --retries 2 --artifacts-dir test/artifacts/replays-android --report-junit test/artifacts/replays-android.junit.xml
