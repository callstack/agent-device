# Android Snapshot Helper

Small instrumentation APK used to capture Android accessibility snapshots without relying on
`uiautomator dump`'s fixed idle wait behavior. The helper enables Android's interactive-window
retrieval flag and serializes every accessible window root returned by `UiAutomation.getWindows()`
so keyboards and system overlays can appear in the same snapshot. If interactive window roots are
unavailable, it falls back to the active-window root.

The helper is intentionally provider-neutral. Local `adb`, cloud ADB tunnels, and remote device
providers can all install and run the same APK as long as they can execute ADB-style operations.
Released helper APKs use the committed `debug.keystore`; do not rotate it casually, because Android
requires a stable signing certificate for `adb install -r` upgrades.

## Build

```sh
VERSION="$(node -p 'require("./package.json").version')"
sh ./scripts/build-android-snapshot-helper.sh "$VERSION" .tmp/android-snapshot-helper
```

The build uses Android SDK command-line tools directly. It expects `ANDROID_HOME` or
`ANDROID_SDK_ROOT` to point at an SDK with `platforms/android-36` and matching build tools.
`pnpm prepack` builds the npm-bundled helper into `android/snapshot-helper/dist`; npm users get
that APK in the package and the first helper-backed `snapshot` installs it automatically when
missing or outdated.

## Run

```sh
VERSION="$(node -p 'require("./package.json").version')"
adb install -r -t ".tmp/android-snapshot-helper/agent-device-android-snapshot-helper-$VERSION.apk"
adb shell am instrument -w \
  -e waitForIdleTimeoutMs 500 \
  -e waitForIdleQuietMs 100 \
  -e timeoutMs 8000 \
  -e maxDepth 128 \
  -e maxNodes 5000 \
  com.callstack.agentdevice.snapshothelper/.SnapshotInstrumentation
```

`maxDepth` also caps recursive traversal depth inside the helper.
The `-t` install flag is required because the helper is a test-only instrumentation APK.
Devices or providers that block test-package installs must allow this package before helper capture
can run.

`waitForIdleTimeoutMs` defaults to `500`, which is a maximum wait, not a fixed sleep. Direct helper
invocations can pass `0` when immediate capture during ongoing animation is preferred.

## Output Contract

The APK emits instrumentation status records using
`agentDeviceProtocol=android-snapshot-helper-v1`.

The XML node attributes intentionally mirror fields consumed by the host parser, including
`visible-to-user`, `drawing-order`, bounds, text/description/id, interaction booleans, and window
metadata on window roots. `drawing-order` lets the host suppress covered same-window surfaces that
the helper traversal can receive even when they are not user-reachable. The helper emits
`drawing-order` on Android API 24+ and omits it on API 23, where the platform API is unavailable.

Each XML chunk is sent with:

- `outputFormat=uiautomator-xml`
- `chunkIndex`
- `chunkCount`
- `payloadBase64`

The final instrumentation result includes:

- `ok=true`
- `helperApiVersion=1`
- `waitForIdleTimeoutMs`
- `waitForIdleQuietMs`
- `timeoutMs`
- `maxDepth`
- `maxNodes`
- `rootPresent`
- `captureMode` (`interactive-windows` or `active-window`)
- `windowCount`
- `nodeCount`
- `truncated`
- `elapsedMs`

Failures return `ok=false`, `errorType`, and `message` in the final result.

The release manifest is a stable provider contract for the current helper protocol. Providers should
resolve the APK from `apkUrl`, verify `sha256`, install using `installArgs`, and run
`instrumentationRunner`. `installArgs` must start with `install`; extra arguments are limited to the
allowlisted adb install flags `-r`, `-t`, `-d`, and `-g`, and the consumer appends the APK path.
