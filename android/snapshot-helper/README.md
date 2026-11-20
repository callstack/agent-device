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

## Accessibility services

On Android API 24+, the helper connects to `UiAutomation` with
`FLAG_DONT_SUPPRESS_ACCESSIBILITY_SERVICES` so enabled accessibility services such as TalkBack
can remain bound during snapshots and gestures. This applies to both persistent sessions and
one-shot operations. API 23 uses the no-argument connection because the flagged overload is
unavailable; other accessibility services can be suppressed while that connection is active.

Reader-specific exploration gestures and speech verification remain a separate feature decision.
A coordinate press does not establish reader accessibility focus or verify speech completion.
See [issue #4179](https://github.com/callstack/agent-device/issues/4179).

## Build

```sh
VERSION="$(node -p 'require("./package.json").version')"
AGENT_DEVICE_ANDROID_HELPER=snapshot sh ./scripts/build-android-helper.sh "$VERSION" .tmp/android-snapshot-helper
```

The build uses Android SDK command-line tools directly. It expects `ANDROID_HOME` or
`ANDROID_SDK_ROOT` to point at an SDK with `platforms/android-36`, and it compiles with the
build-tools version named by `AGENT_DEVICE_ANDROID_BUILD_TOOLS` (or the script's last positional).
CI must name that version; a local build without it uses the newest version under `build-tools`
and says so on stderr.
`pnpm prepack` builds the npm-bundled helper into `android/snapshot-helper/dist`; npm users get
that APK in the package and the first helper-backed `snapshot` installs it automatically when
missing or outdated.

## Run

```sh
VERSION="$(node -p 'require("./package.json").version')"
adb install -r ".tmp/android-snapshot-helper/agent-device-android-snapshot-helper-$VERSION.apk"
adb shell am instrument -w \
  -e waitForIdleTimeoutMs 500 \
  -e waitForIdleQuietMs 100 \
  -e timeoutMs 8000 \
  -e maxDepth 128 \
  -e maxNodes 5000 \
  com.callstack.agentdevice.snapshothelper/.SnapshotInstrumentation
```

`maxDepth` also caps recursive traversal depth inside the helper.
The helper is a plain (non-`testOnly`) instrumentation APK, so it installs without `adb install -t`.
Some OEM builds reject `testOnly` packages from adb outright (ColorOS reports a "PC install attack"),
which is why the helper does not set that flag.

`waitForIdleTimeoutMs` defaults to `500`, which is a maximum wait, not a fixed sleep. Direct helper
invocations can pass `0` when immediate capture during ongoing animation is preferred. Root
acquisition has a separate 500 ms stabilization bound that is used only when no root is available or
an active/focused window is temporarily missing its root; complete captures pay no additional wait.

Child reads run in batches of up to eight on a shared worker pool. This lets Android serve
multiple accessibility requests between animation frames on busy apps. XML retains depth-first
child order and the same depth/node limits. Each capture still clears the accessibility cache;
results are not reused across captures.

## One-Shot Modes

Passing `-e mode snapshot|viewport|gesture` selects what a single instrumentation run does; `snapshot`
is the default and matches the `Run` section above.
The `viewport` mode reads application and keyboard bounds after the same best-effort idle wait
used by snapshots: a 100 ms quiet interval with a 500 ms maximum wait. This allows short window
transitions, including keyboard appearance, to settle without waiting indefinitely on live content.
Snapshot mode uses the idle wait configured above.

```sh
# Read the interactive-window viewport without capturing a snapshot.
adb shell am instrument -w -e mode viewport \
  com.callstack.agentdevice.snapshothelper/.SnapshotInstrumentation

# Inject a planned touch gesture, described by a base64 JSON payload.
adb shell am instrument -w -e mode gesture -e payloadBase64 "$PAYLOAD" \
  com.callstack.agentdevice.snapshothelper/.SnapshotInstrumentation
```

The `gesture` payload is a base64-encoded JSON object using protocol `android-touch-plan-v1`:

- `kind`: `swipe` (one pointer), `transform` (two pointers, e.g. pinch/rotate), or `tap` (2 to 5
  stationary pointers on distinct points)
- `durationMs`: integer, `0`-`120000`
- `pointers`: array of `{ pointerId, samples }`, `pointerId`s ordered from `0`, one pointer for
  `swipe`, exactly two for `transform`, and 2 to 5 for `tap`
- each pointer's `samples` is `{ offsetMs, x, y }[]` with at least two entries; `offsetMs` values
  must be strictly increasing (equal offsets are only allowed when `durationMs` is `0`), the first
  sample's `offsetMs` must be `0`, and the last must equal `durationMs`. For `transform` and `tap`
  gestures, every pointer must share the same `offsetMs` sequence, and a `tap` pointer must not
  move.

## Persistent Session

Passing `-e mode authenticated-session-v1 -e sessionSocket <name>` keeps the instrumentation alive
after startup and serves repeated commands over an abstract `localabstract:` socket named `<name>`,
reached from the host through `adb forward tcp:<port> localabstract:<name>`, instead of exiting after
one snapshot. This avoids paying UiAutomation connect/teardown cost per call. Each command uses one
short-lived connection: the client connects, sends a single command line, reads the response, and the
server closes that connection; the process stays alive for the next connection.

The host owns the socket name and declares it in the launch; the helper binds it unchanged and
refuses a name outside the `agentdevice-snapshot-helper-` namespace. The ready record repeats that
name in `sessionSocket`, and the host refuses a record that names any other socket. The versioned
mode is the whole answer to an old build: a helper that does not implement `authenticated-session-v1`
rejects the launch before it binds anything, and it reads no `sessionPort` argument, so no launch can
talk it into an open loopback TCP listener. The host then fails that start and keeps the device on the
one-shot transport.

Each accepted connection is admitted before any command byte is read. The helper first reads the
peer's kernel credentials with `LocalSocket.getPeerCredentials()` and serves only adbd (shell uid
2000, or root uid 0 under `adb root`); any other uid, or a credential read that yields nothing usable,
is closed without a response. The uid alone does not bind the connection to the host, because adbd
relays every forwarded connection, including one an emulator guest opens to the host forward through
`10.0.2.2`. So every connection also proves a per-session secret in both directions. At startup the
helper draws 32 random bytes and reports them only as `sessionSecret` in its ready record, on the
stdout of the `am instrument` run the host started; the secret is never in argv, logcat or a file,
and it never crosses the socket. The peer then sends a 32-byte nonce line; the helper answers with one
line, `<server nonce> <server proof>`, where the proof is `HMAC-SHA256(secret,
"agent-device-session-server|" + client nonce + server nonce)`; the peer answers with `HMAC-SHA256(secret, "agent-device-session-client|" + server nonce +
client nonce)`. Every nonce and proof is 64 lowercase hex characters; the host accepts the hello only as exactly
those two fields and a newline. The helper reads the
command only after the client proof matches, and the host sends the command only after the server
proof matches, so a process that bound the freed socket name after the helper exited gets the nonce
and nothing else. Any failure closes the connection, and the handshake shares the command's read
deadline.

Each connection gets a command read deadline from acceptance, independent of the capture
`timeoutMs`. The deadline is two seconds, plus one second for each 64 KiB of command bytes that
has arrived, so the largest frame can take about 10 s over a slow remote adb link (at least
~0.5 Mbit/s). Bytes after the newline earn no time, and bytes that arrive after the deadline earn
none either: expiry is checked before they are counted. Reads are nonblocking, and the helper waits
for data with poll only as long as the deadline has left. Each wait takes the deadline itself and
measures its own poll duration when it starts, so a pause before the wait cannot extend it. The
helper does not use the socket timeout, which Android 7.0 and 7.1.0 apply to sends only. A silent
peer closes at two seconds, and a drip-feeding peer cannot hold the command reader past its
deadline. A command ends with a newline. A connection whose read expires, or whose stream ends before
the newline, closes without a response, so a peer that never reads cannot hold the accept loop with a
reply. The line is capped at 513 KiB, a bound derived from the largest supported producer of this
channel. A 10 s two-contact gesture carries 1,252 densified samples, at most ~130 KB Base64. The
documented 64 KiB `fill --text-stdin` contract is larger in the worst case: JSON escapes an accepted
control character such as U+001E from one byte to six, so the value encodes to 524,368 Base64 bytes
before the action and request id. The cap is decided from the raw byte count as soon as it is
crossed, before the newline arrives: a capped prefix is never decoded to decide anything, because
platforms before Android 7.1 decode malformed UTF-8 to fewer bytes than they occupy. A line over the
cap receives a session error and closes. A complete line that is not well-formed UTF-8 closes the
connection without dispatch too. Each response is one frame. The helper builds it inside the
command's failure boundary, so a failure while encoding, such as an out-of-memory on a large
snapshot, returns a minimal error frame with no success payload. The frame goes out in nonblocking
sends under one deadline, fixed when the write starts: eight seconds plus the frame size at 64 KiB/s,
and each readiness wait takes that same deadline. A peer that stops reading is closed at that
deadline, and the connection then closes. A response write failure closes that connection without
another frame. The session keeps serving the next connection:

- `snapshot <requestId>` — capture and return an XML snapshot, same semantics as the default mode
- `snapshot-immediate <requestId>` — capture fresh XML without an idle wait when the caller owns settling
- `snapshot-short-idle <requestId>` — capture with at most a 100 ms idle wait, capped by the session's configured timeout
- `input <requestId> <payloadBase64>` — inject a tap, key, or point-targeted text replacement
- `focus <requestId>` — read the focused window type and root package after clearing the accessibility cache
- `screenshot <requestId>` — return a PNG of the default display in the `payloadBase64` header,
  with the number of logical displays the helper can see in `displayCount` and the default
  display's logical `Surface.ROTATION_*` index in `displayRotation`. `displayRotation` is omitted
  when the rotation changed during the capture or could not be read. Both are omitted when the
  helper could not read its displays.
- `viewport <requestId>` — return interactive-window viewport bounds
- `gesture <requestId> <payloadBase64>` — inject a planned touch gesture (same payload as the
  one-shot `gesture` mode)
- `quit <requestId>` — acknowledge and stop the session

The ready record advertises optional operations in `sessionCommands`. A host must check support before sending them. Text replacement retains a focus tap; the host owns post-write verification. Input failures must not be resent because a mutation may already have reached the app.

The daemon uses the shorter wait for Android `snapshot` and `diff` through the ADB helper only
when the latest stored tree is at least 500 ms old, no later operation has retired it, and no
freshness recovery or post-gesture stabilization is pending. Other captures keep their configured wait. Each capture
still reads a fresh tree. An asynchronous app transition can appear in progress; use an explicit
landmark wait when the next command requires a destination screen.

`viewport` and `gesture` responses are headers-only (no body): `kind`, `injectedEvents`,
`elapsedMs` for `gesture`, and `x`, `y`, `width`, `height` for `viewport`. `snapshot` responses carry
the XML body after the header block, as described below. The response protocol literal is always
`android-snapshot-helper-v1`, regardless of session or one-shot transport.

When an input method window overlaps the application's vertical swipe path, `viewport` responses
also include `keyboardX`, `keyboardY`, `keyboardWidth`, and `keyboardHeight`. All four fields are
omitted when no such window is reported; their absence does not establish that the keyboard is hidden.

## Output Contract

The APK emits instrumentation status records using
`agentDeviceProtocol=android-snapshot-helper-v1`.

The XML node attributes intentionally mirror acquisition facts decoded by the host, including
`visible-to-user`, `drawing-order`, bounds, text/description/id, interaction booleans, and window
metadata on window roots. The helper emits `drawing-order` on Android API 24+ and omits it on API
23, where the platform API is unavailable. The host keeps that fact as private capture evidence;
the daemon uses it to annotate covered actions without adding it to normalized snapshot nodes.
On API 33+ an input method window root also carries `window-region-rect`, whether its touchable
region is a single rectangle (`window-bounds` is that region's bounding box). It is omitted on other
window types, on API 32 and lower, and when the region reads empty.

Each XML chunk is sent with:

- `outputFormat=uiautomator-xml`
- `chunkIndex`
- `chunkCount`
- `payloadBase64`

The final instrumentation result for the default `snapshot` mode includes:

- `ok=true`
- `helperApiVersion=2`
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

`viewport` and `gesture` one-shot results carry `agentDeviceProtocol`/`helperApiVersion`/
`outputFormat` plus the mode-specific fields described under "One-Shot Modes" above, instead of the
`snapshot`-mode fields listed here.

Failures return `ok=false`, `errorType`, and `message` in the final result.

The release manifest is a stable provider contract for the current helper protocol. Providers should
resolve the APK from `apkUrl`, verify `sha256`, install it with `adb install -r <apk>`, and run
`instrumentationRunner`. Manifests up to 0.21.3 also carried an `installArgs` array; it only ever
spelled `install -r` (plus `-t` while the helper was `testOnly`), so consumers can ignore it.

Capture metadata reports `cacheInvalidated` when the capture cleared the platform node cache through `UiAutomation.clearCache()`. A complete capture with that evidence need not change routes after a control press. A press or click opens no freshness window when its `--settle` converged, stored its final capture as the session snapshot, and that capture is complete with that evidence, so the next command reads without freshness recovery. Incomplete captures and captures without that evidence retain freshness recovery.

Warm application open commands use the same automation session. Close retains the existing foreground and process-absence checks. A failed application command is never resent.
