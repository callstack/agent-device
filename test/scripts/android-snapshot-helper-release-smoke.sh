#!/bin/sh
set -eu

PROJECT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)"
PACKAGE_NAME="com.callstack.agentdevice.snapshotsmoke"
APP_LABEL="Agent Device Snapshot Smoke"
# Keep these in sync with the Android workflow SDK packages and emulator API level.
MIN_SDK=23
TARGET_SDK=36

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

WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/agent-device-android-helper-smoke.XXXXXX")"
cleanup() {
  rm -rf "$WORK_DIR"
}
trap cleanup EXIT

SRC_DIR="$WORK_DIR/src/com/callstack/agentdevice/snapshotsmoke"
CLASSES_DIR="$WORK_DIR/classes"
DEX_DIR="$WORK_DIR/dex"
UNSIGNED_APK="$WORK_DIR/app-unsigned.apk"
ALIGNED_APK="$WORK_DIR/app-aligned.apk"
APK_PATH="$WORK_DIR/app-release.apk"
KEYSTORE="$PROJECT_DIR/android/snapshot-helper/debug.keystore"

# This APK is throwaway test code signed with the helper debug keystore only for CI smoke coverage.
mkdir -p "$SRC_DIR" "$CLASSES_DIR" "$DEX_DIR"

cat > "$WORK_DIR/AndroidManifest.xml" <<EOF_MANIFEST
<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="$PACKAGE_NAME">
  <application android:theme="@style/AppTheme" android:label="$APP_LABEL" android:allowBackup="false" android:supportsRtl="true">
    <activity android:name=".MainActivity" android:exported="true">
      <intent-filter>
        <action android:name="android.intent.action.MAIN" />
        <category android:name="android.intent.category.LAUNCHER" />
      </intent-filter>
    </activity>
  </application>
</manifest>
EOF_MANIFEST

mkdir -p "$WORK_DIR/res/values"
cat > "$WORK_DIR/res/values/styles.xml" <<EOF_STYLES
<resources>
  <style name="AppTheme" parent="@android:style/Theme.Material.Light.NoActionBar" />
</resources>
EOF_STYLES

cat > "$SRC_DIR/MainActivity.java" <<'EOF_JAVA'
package com.callstack.agentdevice.snapshotsmoke;

import android.app.Activity;
import android.os.Bundle;
import android.view.Gravity;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;

public final class MainActivity extends Activity {
  @Override
  protected void onCreate(Bundle savedInstanceState) {
    super.onCreate(savedInstanceState);

    LinearLayout layout = new LinearLayout(this);
    layout.setOrientation(LinearLayout.VERTICAL);
    layout.setGravity(Gravity.CENTER);
    layout.setPadding(32, 32, 32, 32);

    TextView title = new TextView(this);
    title.setText("Snapshot helper release smoke");
    title.setTextSize(22);
    title.setGravity(Gravity.CENTER);
    layout.addView(
        title,
        new LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

    Button button = new Button(this);
    button.setText("Release smoke ready");
    layout.addView(
        button,
        new LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT));

    setContentView(layout);
  }
}
EOF_JAVA

javac \
  --release 11 \
  -classpath "$ANDROID_JAR" \
  -d "$CLASSES_DIR" \
  "$SRC_DIR/MainActivity.java"

"$BUILD_TOOLS_DIR/d8" \
  --min-api "$MIN_SDK" \
  --classpath "$ANDROID_JAR" \
  --output "$DEX_DIR" \
  $(find "$CLASSES_DIR" -name '*.class' | sort)

"$BUILD_TOOLS_DIR/aapt2" compile \
  --dir "$WORK_DIR/res" \
  -o "$WORK_DIR/compiled.zip"

"$BUILD_TOOLS_DIR/aapt2" link \
  --manifest "$WORK_DIR/AndroidManifest.xml" \
  -I "$ANDROID_JAR" \
  --min-sdk-version "$MIN_SDK" \
  --target-sdk-version "$TARGET_SDK" \
  --version-code 1 \
  --version-name 1.0 \
  -o "$UNSIGNED_APK" \
  "$WORK_DIR/compiled.zip"

zip -q -j "$UNSIGNED_APK" "$DEX_DIR/classes.dex"
"$BUILD_TOOLS_DIR/zipalign" -f 4 "$UNSIGNED_APK" "$ALIGNED_APK"
"$BUILD_TOOLS_DIR/apksigner" sign \
  --ks "$KEYSTORE" \
  --ks-pass pass:android \
  --key-pass pass:android \
  --out "$APK_PATH" \
  "$ALIGNED_APK"
"$BUILD_TOOLS_DIR/apksigner" verify --min-sdk-version "$MIN_SDK" "$APK_PATH"

node --experimental-strip-types "$PROJECT_DIR/src/bin.ts" install "$PACKAGE_NAME" "$APK_PATH" --platform android
node --experimental-strip-types "$PROJECT_DIR/src/bin.ts" open "$PACKAGE_NAME" --platform android --relaunch
node --experimental-strip-types "$PROJECT_DIR/src/bin.ts" wait 'label="Release smoke ready" || text="Release smoke ready"' 10000 --platform android
node --experimental-strip-types "$PROJECT_DIR/src/bin.ts" snapshot -i --platform android --json > "$WORK_DIR/snapshot.json"

node - "$WORK_DIR/snapshot.json" <<'EOF_NODE'
const fs = require('node:fs');

const snapshot = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const nodes = snapshot?.data?.nodes ?? snapshot?.nodes ?? [];
const androidSnapshot = snapshot?.data?.androidSnapshot ?? snapshot?.androidSnapshot;
const labels = nodes.map((node) => String(node.label ?? node.text ?? ''));

if (androidSnapshot?.backend !== 'android-helper') {
  throw new Error(`Expected android-helper backend, received ${androidSnapshot?.backend}`);
}
if (!labels.some((label) => label.toLowerCase().includes('release smoke ready'))) {
  throw new Error(`Expected release smoke label in snapshot labels: ${labels.join(', ')}`);
}
EOF_NODE
