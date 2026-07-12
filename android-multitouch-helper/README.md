# Android MultiTouch Helper

Small instrumentation APK used to inject Android touch gestures through
`UiAutomation.injectInputEvent`. The helper accepts a compact base64 JSON payload so local ADB,
remote ADB tunnels, and remote providers that allow `adb install -t` plus `am instrument` can use
the same contract.

The helper is separate from `android-snapshot-helper` because the payload and output protocol are
gesture-specific. The install/version/cache lifecycle should stay aligned with the snapshot helper.

## Build

```sh
VERSION="$(node -p 'require("./package.json").version')"
sh ./scripts/build-android-multitouch-helper.sh "$VERSION" .tmp/android-multitouch-helper
```

## Run

```sh
PAYLOAD_JSON='{
  "protocol":"android-multitouch-helper-v1",
  "kind":"transform",
  "durationMs":32,
  "pointers":[
    {"pointerId":0,"samples":[{"offsetMs":0,"x":120,"y":180},{"offsetMs":16,"x":130,"y":175},{"offsetMs":32,"x":140,"y":170}]},
    {"pointerId":1,"samples":[{"offsetMs":0,"x":120,"y":260},{"offsetMs":16,"x":135,"y":270},{"offsetMs":32,"x":150,"y":280}]}
  ]
}'
PAYLOAD="$(printf '%s' "$PAYLOAD_JSON" | base64)"
adb install -r -t ".tmp/android-multitouch-helper/agent-device-android-multitouch-helper-$VERSION.apk"
adb shell am instrument -w \
  -e payloadBase64 "$PAYLOAD" \
  com.callstack.agentdevice.multitouchhelper/.MultiTouchInstrumentation
```

## Output Contract

The APK emits instrumentation result records using
`agentDeviceProtocol=android-multitouch-helper-v1`.

Before planning a gesture, the runtime invokes the same instrumentation with
`-e mode viewport`. That read-only mode waits for `UiAutomation` window state and returns the
active application window bounds, falling back to the active accessibility root when Android does
not expose interactive-window metadata. It does not use or cache the physical display size.

Successful results include:

- `ok=true`
- `helperApiVersion=1`
- `kind` (`swipe` for one planned pointer path or `transform` for two)
- `injectedEvents`
- `elapsedMs`

Viewport results use `kind=viewport` plus `x`, `y`, `width`, and `height`.

Failures return `ok=false`, `errorType`, and `message`.
