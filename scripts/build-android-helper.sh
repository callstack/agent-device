#!/bin/sh
set -eu

HELPER="${AGENT_DEVICE_ANDROID_HELPER:-}"
if [ -z "$HELPER" ]; then
  HELPER="${1:-}"
  [ "$#" -ge 1 ] && shift
fi

if [ "$#" -lt 2 ] || [ "$#" -gt 3 ]; then
  echo "Usage: AGENT_DEVICE_ANDROID_HELPER=<snapshot|ime> $0 <version> <output-dir> [build-tools-version]" >&2
  echo "   or: $0 <snapshot|ime> <version> <output-dir> [build-tools-version]" >&2
  echo "The version also comes from AGENT_DEVICE_ANDROID_BUILD_TOOLS." >&2
  exit 1
fi

VERSION="$1"
OUTPUT_DIR="$2"
BUILD_TOOLS_VERSION="${3:-${AGENT_DEVICE_ANDROID_BUILD_TOOLS:-}}"
PROJECT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
MIN_SDK=23
TARGET_SDK=36
KEYSTORE="$PROJECT_DIR/android/snapshot-helper/debug.keystore"

# Per-helper config: HELPER_DIR/PACKAGE_NAME/APK name always differ; RUN_TEST_CLASS is
# only set for the snapshot helper (it has a unit test to compile+run); RESOURCE_DIR is
# only set for the ime helper (it has a res/ dir that needs an aapt2 compile pass).
case "$HELPER" in
  snapshot)
    HELPER_DIR="$PROJECT_DIR/android/snapshot-helper"
    PACKAGE_NAME="com.callstack.agentdevice.snapshothelper"
    RUN_TEST_CLASS="com.callstack.agentdevice.snapshothelper.SnapshotHelperTestSuite"
    RESOURCE_DIR=""
    ;;
  ime)
    HELPER_DIR="$PROJECT_DIR/android/ime-helper"
    PACKAGE_NAME="com.callstack.agentdevice.imehelper"
    RUN_TEST_CLASS=""
    RESOURCE_DIR="$PROJECT_DIR/android/ime-helper/res"
    ;;
  *)
    echo "Unknown Android helper: '$HELPER' (expected 'snapshot' or 'ime')" >&2
    exit 1
    ;;
esac

APK_BASENAME="agent-device-android-$HELPER-helper-$VERSION.apk"

SDK_ROOT="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}"
if [ -z "$SDK_ROOT" ] || [ ! -d "$SDK_ROOT" ]; then
  echo "ANDROID_HOME or ANDROID_SDK_ROOT must point to an Android SDK" >&2
  exit 1
fi

ANDROID_JAR="$SDK_ROOT/platforms/android-$TARGET_SDK/android.jar"
if [ ! -f "$ANDROID_JAR" ]; then
  echo "Missing Android platform jar: $ANDROID_JAR" >&2
  exit 1
fi

# d8 and aapt2 come from build-tools, so the version decides the compiled bytecode and resources,
# not only packaging. CI names the version it installed; only a local build may take the newest.
if [ -z "$BUILD_TOOLS_VERSION" ]; then
  if [ "${CI:-}" = "true" ]; then
    echo "AGENT_DEVICE_ANDROID_BUILD_TOOLS must name a build-tools version under $SDK_ROOT/build-tools" >&2
    exit 1
  fi
  NEWEST_BUILD_TOOLS_DIR="$(
    find "$SDK_ROOT/build-tools" -maxdepth 1 -mindepth 1 -type d 2>/dev/null | sort -V | tail -n 1
  )"
  if [ -z "$NEWEST_BUILD_TOOLS_DIR" ]; then
    echo "No Android build tools installed under $SDK_ROOT/build-tools" >&2
    exit 1
  fi
  BUILD_TOOLS_VERSION="${NEWEST_BUILD_TOOLS_DIR##*/}"
  echo "No build-tools version requested; newest installed is $BUILD_TOOLS_VERSION" >&2
fi

case "$BUILD_TOOLS_VERSION" in
  */* | *[[:space:]]*)
    echo "Not an Android build-tools version: '$BUILD_TOOLS_VERSION'" >&2
    exit 1
    ;;
esac

BUILD_TOOLS_DIR="$SDK_ROOT/build-tools/$BUILD_TOOLS_VERSION"
if [ ! -d "$BUILD_TOOLS_DIR" ]; then
  echo "No Android build tools $BUILD_TOOLS_VERSION under $SDK_ROOT/build-tools" >&2
  exit 1
fi

for BUILD_TOOL in aapt2 d8 zipalign apksigner; do
  if [ ! -x "$BUILD_TOOLS_DIR/$BUILD_TOOL" ]; then
    echo "Incomplete Android build tools: no $BUILD_TOOL in $BUILD_TOOLS_DIR" >&2
    exit 1
  fi
done

VERSION_CODE="$(
  printf '%s\n' "$VERSION" | awk -F. '
    /^[0-9]+[.][0-9]+[.][0-9]+$/ {
      print ($1 * 1000000) + ($2 * 1000) + $3
      next
    }
    { print 1 }
  '
)"

BUILD_DIR="$HELPER_DIR/build"
CLASSES_DIR="$BUILD_DIR/classes"
TEST_CLASSES_DIR="$BUILD_DIR/test-classes"
DEX_DIR="$BUILD_DIR/dex"
RES_COMPILED_DIR="$BUILD_DIR/res-compiled"
UNSIGNED_APK="$BUILD_DIR/helper-unsigned.apk"
ALIGNED_APK="$BUILD_DIR/helper-aligned.apk"
APK_PATH="$OUTPUT_DIR/$APK_BASENAME"

rm -rf "$BUILD_DIR"
mkdir -p "$CLASSES_DIR" "$TEST_CLASSES_DIR" "$DEX_DIR" "$RES_COMPILED_DIR" "$OUTPUT_DIR"

javac \
  --release 11 \
  -classpath "$ANDROID_JAR" \
  -d "$CLASSES_DIR" \
  $(find "$HELPER_DIR/src/main/java" -name '*.java' | sort)

if [ -n "$RUN_TEST_CLASS" ]; then
  javac \
    --release 11 \
    -classpath "$ANDROID_JAR:$CLASSES_DIR" \
    -d "$TEST_CLASSES_DIR" \
    $(find "$HELPER_DIR/src/test/java" -name '*.java' | sort)

  java \
    -classpath "$ANDROID_JAR:$CLASSES_DIR:$TEST_CLASSES_DIR" \
    "$RUN_TEST_CLASS"
fi

"$BUILD_TOOLS_DIR/d8" \
  --min-api "$MIN_SDK" \
  --classpath "$ANDROID_JAR" \
  --output "$DEX_DIR" \
  $(find "$CLASSES_DIR" -name '*.class' | sort)

if [ -n "$RESOURCE_DIR" ]; then
  "$BUILD_TOOLS_DIR/aapt2" compile \
    --dir "$RESOURCE_DIR" \
    -o "$RES_COMPILED_DIR"

  "$BUILD_TOOLS_DIR/aapt2" link \
    --manifest "$HELPER_DIR/AndroidManifest.xml" \
    -I "$ANDROID_JAR" \
    --min-sdk-version "$MIN_SDK" \
    --target-sdk-version "$TARGET_SDK" \
    --version-code "$VERSION_CODE" \
    --version-name "$VERSION" \
    -R "$RES_COMPILED_DIR"/*.flat \
    -o "$UNSIGNED_APK"
else
  "$BUILD_TOOLS_DIR/aapt2" link \
    --manifest "$HELPER_DIR/AndroidManifest.xml" \
    -I "$ANDROID_JAR" \
    --min-sdk-version "$MIN_SDK" \
    --target-sdk-version "$TARGET_SDK" \
    --version-code "$VERSION_CODE" \
    --version-name "$VERSION" \
    -o "$UNSIGNED_APK"
fi

zip -q -j "$UNSIGNED_APK" "$DEX_DIR/classes.dex"

"$BUILD_TOOLS_DIR/zipalign" -f 4 "$UNSIGNED_APK" "$ALIGNED_APK"

if [ ! -f "$KEYSTORE" ]; then
  echo "Missing Android helper signing keystore: $KEYSTORE" >&2
  exit 1
fi

"$BUILD_TOOLS_DIR/apksigner" sign \
  --ks "$KEYSTORE" \
  --ks-pass pass:android \
  --key-pass pass:android \
  --out "$APK_PATH" \
  "$ALIGNED_APK"

"$BUILD_TOOLS_DIR/apksigner" verify --min-sdk-version "$MIN_SDK" "$APK_PATH"

printf 'apk=%s\n' "$APK_PATH"
printf 'package=%s\n' "$PACKAGE_NAME"
printf 'version_code=%s\n' "$VERSION_CODE"
