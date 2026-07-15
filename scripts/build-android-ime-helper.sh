#!/bin/sh
set -eu

if [ "$#" -ne 2 ]; then
  echo "Usage: $0 <version> <output-dir>" >&2
  exit 1
fi

VERSION="$1"
OUTPUT_DIR="$2"
PROJECT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
HELPER_DIR="$PROJECT_DIR/android/ime-helper"
PACKAGE_NAME="com.callstack.agentdevice.imehelper"
MIN_SDK=23
TARGET_SDK=36
APK_BASENAME="agent-device-android-ime-helper-$VERSION.apk"

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

BUILD_TOOLS_DIR="$(
  find "$SDK_ROOT/build-tools" -maxdepth 1 -mindepth 1 -type d 2>/dev/null | sort -V | tail -n 1
)"
if [ -z "$BUILD_TOOLS_DIR" ] || [ ! -x "$BUILD_TOOLS_DIR/aapt2" ]; then
  echo "Missing Android build tools under $SDK_ROOT/build-tools" >&2
  exit 1
fi

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
DEX_DIR="$BUILD_DIR/dex"
RES_COMPILED_DIR="$BUILD_DIR/res-compiled"
KEYSTORE="$PROJECT_DIR/android/snapshot-helper/debug.keystore"
UNSIGNED_APK="$BUILD_DIR/helper-unsigned.apk"
ALIGNED_APK="$BUILD_DIR/helper-aligned.apk"
APK_PATH="$OUTPUT_DIR/$APK_BASENAME"

rm -rf "$BUILD_DIR"
mkdir -p "$CLASSES_DIR" "$DEX_DIR" "$RES_COMPILED_DIR" "$OUTPUT_DIR"

javac \
  --release 11 \
  -classpath "$ANDROID_JAR" \
  -d "$CLASSES_DIR" \
  $(find "$HELPER_DIR/src/main/java" -name '*.java' | sort)

"$BUILD_TOOLS_DIR/d8" \
  --min-api "$MIN_SDK" \
  --classpath "$ANDROID_JAR" \
  --output "$DEX_DIR" \
  $(find "$CLASSES_DIR" -name '*.class' | sort)

# Only this helper has a resource (res/xml/method.xml), so it needs an aapt2 compile pass.
"$BUILD_TOOLS_DIR/aapt2" compile \
  --dir "$HELPER_DIR/res" \
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
