# iOS Runner Protocol

The Apple runner speaks a small internal HTTP+JSON protocol between the TypeScript daemon and the XCUITest host. This protocol is a maintainer document, not part of the public user docs, but it should stay explicit so the TypeScript and Swift sides do not drift.

## Transport

- Endpoint: `POST /command`
- Content type: `application/json`
- Request body: one JSON command object
- Response body: one JSON envelope
- HTTP/1.1 connections persist by default. `Connection: close` ends them after the response.
- HTTP/1.0 connections persist only when the request includes `Connection: keep-alive`.
- Pipelined requests run in order. Each request repeats token, route, and length validation.
- Shutdown and framing or authentication refusals close the connection. Shutdown closes other open connections after all coalesced shutdown responses finish sending.

The daemon sends to `http://127.0.0.1:<port>/command` for simulator and macOS runners. A physical device is reached over usbmux when cabled, otherwise at its CoreDevice tunnel address; it is never dialed at this Mac's loopback.

Loopback and CoreDevice tunnel requests use the global `fetch` connection pool to reuse TCP
connections. The usbmux transport sends `Connection: close` and opens a connection per request.

### Listener binding

Simulators and macOS bind `127.0.0.1` only. A physical device listens on every interface: a cabled
device is reached through usbmux on device loopback, and a Wi-Fi-only CoreDevice device through its
tunnel address, which arrives on a `utun` interface of type `.other`.

The runner classifies each connection once it is ready (`RunnerListenerPeer.swift`): a loopback or
tunnel peer is served, and a peer on any other interface (Wi-Fi, Ethernet, cellular, a Personal
Hotspot bridge) reached the device directly and is closed before it is read.

### Listener token

The daemon mints a token (24 random bytes, base64url) for each runner launch. The session
xctestrun carries it with the port, as `AGENT_DEVICE_RUNNER_TOKEN` and `AGENT_DEVICE_RUNNER_PORT`,
in each test target's `EnvironmentVariables`: the runner process's environment, which the app under
test does not inherit. The runner refuses to start its listener without both.

Every request presents it as `X-Agent-Device-Runner-Token`, exactly once. The runner checks it, in
constant time, as soon as the request head is complete and before routing, length checks, or body
decoding. That applies to every command, including `status`, `uptime`, and `shutdown`. A missing or
wrong token answers `401` with error code `UNAUTHORIZED`.

Every response carries `X-Agent-Device-Runner-Auth: required`. The daemon refuses a reply without
it: such a runner was built before the token existed and listens without one.

### Request framing

Checked in this order once the head is complete (`RunnerHttpRequestFraming.swift`):

| Condition | Status |
| --- | --- |
| Head over 16 KiB | `431` |
| Malformed request line or header | `400` |
| Missing, duplicated, or wrong token | `401` |
| Method other than `POST` | `405` |
| Path other than `/command` | `404` |
| Any `Transfer-Encoding` | `400` |
| `Content-Length` missing or duplicated | `411` |
| `Content-Length` not plain decimal digits | `400` |
| Body over 2 MiB | `413` |

A request must arrive within 30 s, or it is answered `408`. The clock starts when the connection is
accepted, except for a loopback peer, whose clock starts at its first byte: the simulator listener
watch holds an idle loopback connection to observe the runner's lifetime. Each refusal closes only
its own connection; the listener keeps serving.

After a response, a reusable connection may idle for 30 s before it closes silently. The next
request gets a fresh 30 s arrival deadline starting at its first byte. Already-buffered requests
start that deadline when processing advances to them. The initial unused loopback listener watch
remains exempt from idle expiry. Command execution time does not consume the arrival or idle budget.

A runner reply without `X-Agent-Device-Runner-Auth: required` is session-fatal on the host: the
session is invalidated, which stops the runner, and the command is neither resent nor replayed.
Until a session has answered, every mutation is preceded by an `uptime` probe, so a runner that does
not require the token never receives one.

## Request Shape

Every request includes a `command` field. Additional fields depend on the command family.
The request vocabulary is `contracts/fixtures/runner-requests.json`: the requests production builds.

Examples:

```json
{ "command": "tap", "x": 120, "y": 240 }
```

```json
{
  "command": "snapshot",
  "interactiveOnly": true,
  "depth": 2,
  "scope": "app",
  "raw": false,
  "customActions": false
}
```

`customActions` asks the capture to name each merged element's
`UIAccessibilityCustomAction`s in a node's `actions` array. It pins the
private-AX backend (no other backend can read them) and costs one accessibility
round trip per merged element, so it is opt-in.

The pass is bounded on four axes, and every bound is disclosed through
`snapshotQuality.customActions` `{read, candidates, truncated, blocked}` rather
than silently applied:

- at most 12 elements per capture, on-screen first, stopping at the capture
  deadline — `read < candidates` means the rest were not read;
- 1s per element read, so one wedged element cannot consume the capture budget
  (a timed-out element counts as unread, never as "read, has no actions");
- at most 8 action names per element, each at most 80 characters —
  `truncated` counts elements whose list was clipped;
- one read in flight at a time. The AX call cannot be cancelled once issued, so
  the deadline frees only the caller; the call itself keeps running. All reads
  therefore share one serial queue, and while an abandoned read is still
  outstanding the pass is skipped outright (`blocked`) instead of queueing
  behind it — repeating the capture adds no work. Reads resume on their own
  once the hung call returns.

```json
{ "command": "recordStart", "outPath": "/tmp/demo.mp4", "fps": 30 }
```

```json
{ "command": "rotate", "orientation": "landscape-left" }
```

```json
{ "command": "appState", "appBundleId": "com.example.app" }
```

```json
{ "command": "backInApp", "appBundleId": "com.example.app" }
```

`backInApp` is the only back command. On iOS the runner first reads the current tree, in the same
call, for the navigation bar's system back button: a button with the identifier `BackButton` inside a
navigation bar. It taps that button with a synthesized tap only when exactly one live, hittable
candidate is found in a readable tree, and two reads in a row of the bar state, with a 0.05 s pause
between them, agree and contain that button's frame; each round re-reads the buttons. The match
places the snapshot frames at the window's screen origin, because a placed iPad window reports them
from its own top-left. No other button
counts, whatever its label.
The bar state is the labels of each navigation bar's `BackButton` children, one list per bar in
bar order, and the frames of those buttons; one XCTest snapshot per bar. The still check before the
tap compares labels and frames. Bar titles and identifiers are left out, because a bar can retitle
itself (a countdown) without navigating. After the tap it reads that state again with a 0.05 s
pause between reads. Only these changes from the state read before the tap answer `ok`: the number
of bars, the number of `BackButton` children (such as none at the root), or a `BackButton` label.
Frames are left out after the tap, because a tap that navigates nowhere can still move the button
(a large-title collapse, a bar button that appears). A pop that keeps the same `BackButton` labels
and bar count, such as one between two screens whose back buttons have the same title, answers
`BACK_SWIPE_UNVERIFIED`; so can a pop on a
back button whose title updates itself, misread as a navigation. No change, or reads that fail, answer `BACK_SWIPE_UNVERIFIED`; a delivered tap is
never followed by the swipe. Before and after the tap, reads start for up to 1 s each, checked
before each bar's snapshot; a query in flight finishes or ends at XCTest's own query timeout.
After the tap, when no read in the 1 s saw a change or hung, the runner starts one more read after
the 1 s, with no deadline of its own: a snapshot of a bar that vanished mid-pop can spend the 1 s in
XCTest's retries, and this read can still see the screen after the pop. That read can also fail,
which answers `BACK_SWIPE_UNVERIFIED`, or hang, which ends at XCTest's own query timeout and also
answers `BACK_SWIPE_UNVERIFIED`. A read in flight can run well past the 1 s: one bar snapshot took
about 2 s on a CI simulator.

Every bar read holds its XCTest issues. A held issue means the read proved nothing. A hung query
("Timed out while evaluating UI query") is recorded again, and no further query follows it: before
the tap the runner answers `BACK_SWIPE_NOT_DISPATCHED` with nothing sent, and after it
`BACK_SWIPE_UNVERIFIED`.

The runner swipes instead when no tap was sent:

- The tree read is skipped: the window resolution marked the tree unreadable, accessibility is
  unavailable, or the XCTest snapshot channel is penalized for the app.
- The read fails or XCTest rejects one of its queries.
- No candidate is found, or two or more are (such as a sheet over a stack).
- The bar state does not hold still within 1 s.
- The synthesized tap is refused before anything is sent.

A tap whose outcome is unknown after it may have been sent throws, and neither the bar check nor
the swipe follows. The swipe verifies a change of the app's screen. When XCTest cannot resolve the
app's window, it samples the sole screen only on an iPhone, or on an iPad while the app provably
fills its screen; otherwise it refuses with `APP_SCREEN_UNRESOLVED`. Its failure codes are:

| Code | When | Sent |
| --- | --- | --- |
| `APP_SCREEN_WINDOW_UNRESOLVED`, `APP_SCREEN_UNRESOLVED`, `APP_SCREEN_CAPTURE_UNRENDERABLE`, `APP_SCREEN_OFF_LIT_PANEL` | The screen could not be sampled before the swipe. | Nothing |
| `BACK_SWIPE_NOT_DISPATCHED` | The swipe was refused before any touch went down, an XCTest query on the navigation bar hung before the tap, or the platform has no back command (visionOS; the daemon refuses it first). | Nothing |
| `BACK_SWIPE_NO_CHANGE` | The swipe was sent and the sampled grid (48×96 grayscale cells, with the top 7 rows always left out; in portrait they hold the status bar and Dynamic Island, and in landscape the iPhone status bar is hidden and the Dynamic Island sits at a side edge, outside those rows) changed in at most 1% of the remaining cells by more than 24 of 256 levels. | The swipe |
| `BACK_SWIPE_UNVERIFIED` | The swipe may have run, or the back button was tapped and the bar's back buttons did not change within 1 s or on one more read after it or a query on it hung; the outcome is unknown. | Possibly the swipe, or the tap |

The swipe is first resolved up to its contact. Then the settle window is a run of samples, with a
0.05 s pause between captures plus each capture's own time, that agree for the still span: a contact
allowance, a 0.25 s margin, and the slowest capture seen while settling, about 0.55 s on a simulator.
The margin keeps a screen that repaints itself about every 0.5 s from looking still, so its next
repaint is not read as the swipe's effect; it does not depend on the 0.1 s wait before the sample
after the swipe. A slow host therefore settles for longer. The last sample of that run is the one the change is measured from, and the
swipe follows it at once:

| Platform | Resolved before settling | Left in the gap | Contact allowance |
| --- | --- | --- | --- |
| Simulator | the edge-touch plan, its display, and the HID touchscreen sender | the 100 ms edge contact | 0.2 s |
| Device | the synthesized fling plan (2 pt inside the leading edge to 0.9 of the width, no hold), with every tree and window read it needs | the 200 ms fling | 0.4 s |

On both, every tree and window read happens during that preparation, before the first sample.

Settling samples for at most 2 s, plus the capture in flight. On a slow host the budget grows to the first capture, the still span, and one more pause and capture, so a still screen settles instead of always answering `BACK_SWIPE_UNVERIFIED`. A still screen usually settles after
5 samples, about 0.6 s on a local simulator with 0.1 s captures; with the 0.4 s captures measured
on one physical iPhone (iPhone 17 Pro, iOS 27.0.1;
https://github.com/callstack/agent-device/pull/4460#issuecomment-6828546541) the still span is 1.05 s.

Only a change from the last sample to the sample taken 0.1 s after the swipe counts, and only when the time
between those two does not exceed the time the screen had been still; otherwise the result is
`BACK_SWIPE_UNVERIFIED`. Then the swipe may or may not have navigated: run `snapshot` to see the
current screen before acting again. A screen that animates on its own more slowly than the settle
window can still be misread as a back navigation; any finite window has that limit, so also run
`snapshot` after `back` on a screen with auto-advancing content.

Each iOS back whose window context resolved logs one `AGENT_DEVICE_RUNNER_BACK_NAVIGATION_BAR_BUTTON`
line on every exit of the button path, a thrown tap included, with `found` (`skipped`,
`unreadable`, `hung`, `moving`, `no`, `ambiguous`, or `yes`), `pressed`, `confirmed` (`yes`, `no`,
`hung`, or `-` before a tap), `lookupMs` (`0` when the read was
skipped), and `confirmMs`. Each swipe logs one runner line, `AGENT_DEVICE_RUNNER_BACK_SWIPE_VERIFICATION`, on every exit, with its
`outcome` (`performed`, `refused`, `unconfirmed`, or `error` for a thrown failure), `code`, `changed`, `stableMs`, `justBeforeToAfterMs`, `gestureMs`, `maxCaptureMs`,
`settleSamples`, and `settled`.

The `backSystem` command was removed (#4460). This protocol carries no version: the daemon and the runner are built from the same
agent-device version, and a configured `iosXctestrunFile` must be too, so no peer still sends it.

`appState` answers `data.applicationState` with the named app's `XCUIApplication.State` by name
(`runningForeground`, `runningBackground`, `runningBackgroundSuspended`, `notRunning`, `unknown`).
It is a lifecycle read, so the activation preflight is skipped and the state reported is the one
the app is in, not the one a repair would leave.

The current command names and per-command traits are defined in:

- `RunnerCommand` in [`../../packages/apple-runner/src/runner-contract.ts`](../../packages/apple-runner/src/runner-contract.ts)
- `RUNNER_COMMAND_TRAITS` in [`../../packages/apple-runner/src/runner-command-traits.ts`](../../packages/apple-runner/src/runner-command-traits.ts)
- `CommandType` in [`AgentDeviceRunner/AgentDeviceRunnerUITests/RunnerTests+Models.swift`](AgentDeviceRunner/AgentDeviceRunnerUITests/RunnerTests+Models.swift)

## Response Shape

Successful and failed responses use the same top-level envelope:

```json
{
  "ok": true,
  "data": {
    "message": "ok"
  }
}
```

```json
{
  "ok": false,
  "error": {
    "code": "KEYBOARD_DISMISS_UNAVAILABLE",
    "message": "Unable to dismiss the keyboard: it exposes no dismiss key, and background taps are never attempted (no tap outside the keyboard can be proven side-effect-free)"
  }
}
```

The example is a `keyboard dismiss` the keyboard would not come down for; a refusal that can name a
next step also carries `hint`, omitted here. A keyboard that stayed up answers one of two codes:
`KEYBOARD_DISMISS_UNAVAILABLE` when it found no dismiss control and so sent nothing, or
`UNSUPPORTED_OPERATION` when a dismiss control was tapped, or the tvOS remote's Menu press was sent,
and the keyboard stayed visible. The host reports both under `UNSUPPORTED_OPERATION` and publishes the
first one's `details.reason`.

Three more refusals name the control the target could not supply, so a caller never reads the refusal
off `message`. `KEYBOARD_RETURN_UNAVAILABLE` is a `keyboard enter` whose keyboard exposed no return-like
key and for which no text field could be found; it proves no submission, not that nothing ran, because
the sole-text-field route taps the field before typing. `HARDWARE_CONTROL_UNAVAILABLE` is a press of a
control this target cannot express — the Action Button on a model without one, a volume key on a
simulator, or a Siri Remote button off tvOS — and `IN_APP_BACK_CONTROL_UNAVAILABLE` is macOS `back`
finding no in-app back control in the app's tree. The last two press nothing. The host maps each to the
code its command already refused with (the first three to `UNSUPPORTED_OPERATION`, the macOS back
refusal to the `COMMAND_FAILED` a code-less reply produced) and publishes its `details.reason`.

`data` is command-specific. Common fields include snapshot nodes, text lookup results, gesture timing, visibility metadata, and screenshot or recording output details.

Capture-plan snapshots carry `snapshotViewport`, the acquisition's declared viewport evidence.
Its shape is `{kind: "reported" | "derived", rect: {x, y, width, height}}` or
`{kind: "missing", reason: "not-provided" | "invalid"}`.
`derived` and `missing` establish no screen origin.
A root box used to validate presented nodes does not upgrade this evidence.

A synthesized long press, scroll, or planned gesture reports how far it got; on iOS the CLI `swipe` is
a planned fling `gesture` that runs as a synthesized drag, so it reports the same way.
`SYNTHESIZED_GESTURE_NOT_DISPATCHED` means the iOS event synthesis refused before its event record was
handed to XCTest, so the command sent nothing. It also covers a planned gesture refused on iOS while
its window or display is resolved (the window cannot be named, or the sole display cannot be
measured), before any synthesis. Any other refusal keeps `UNSUPPORTED_OPERATION`. `SYNTHESIZED_GESTURE_OUTCOME_UNKNOWN` means it failed after its event
record was handed to XCTest. That is not confirmed delivery: the record can still fail before its
events run. The gesture may have run, so the runner does not fall back to an XCTest gesture that
would repeat it. A sequence long-press step reports the same two codes as the step's `errorCode`. The runner does not
report a dispatch for the whole sequence: the daemon derives it from the step code when
`completedSteps` is 0, and reports `dispatched: unknown` once an earlier step completed.

## Maintenance Rules

- Treat the TypeScript and Swift wire models as a single contract.
- When adding, removing, or renaming a command, update the protocol fixtures/tests in the same change.
- Keep this file focused on the actual wire shape rather than implementation details of command execution.

## Recovery, Busy State, and Error Codes

These behaviors are owned by code. This section only says where each one is declared; read the
declaration for the current rules.

- **Command ids and `status` recovery.** The daemon attaches a `commandId` with `withRunnerCommandId`
  ([`runner-contract.ts`](../../packages/apple-runner/src/runner-contract.ts)). The runner records commands in
  `RunnerCommandJournal` ([`RunnerTests+CommandJournal.swift`](AgentDeviceRunner/AgentDeviceRunnerUITests/RunnerTests+CommandJournal.swift)) and
  answers the `status` command in `executeStatus`
  ([`RunnerTests+CommandDispatch.swift`](AgentDeviceRunner/AgentDeviceRunnerUITests/RunnerTests+CommandDispatch.swift)). The daemon's recovery
  decisions live in [`runner-command-recovery.ts`](../../packages/apple-runner/src/runner-command-recovery.ts).
- **`runnerMainThreadBusy`.** The runner stamps successful responses with `stampingCurrentMainThreadBusy`
  ([`RunnerTests+Models.swift`](AgentDeviceRunner/AgentDeviceRunnerUITests/RunnerTests+Models.swift)) from `currentMainThreadBusyState()`
  ([`RunnerTests+MainThreadWork.swift`](AgentDeviceRunner/AgentDeviceRunnerUITests/RunnerTests+MainThreadWork.swift)), applied in `jsonResponse`
  ([`RunnerTests+Transport.swift`](AgentDeviceRunner/AgentDeviceRunnerUITests/RunnerTests+Transport.swift)). The daemon reads the stamp in [`runner-session.ts`](../../packages/apple-runner/src/runner-session.ts).
- **`runnerFatal`.** A field of the response data (`runnerFatal` in
  [`RunnerTests+Models.swift`](AgentDeviceRunner/AgentDeviceRunnerUITests/RunnerTests+Models.swift)); for example, a sparse snapshot payload in
  [`RunnerTests+Snapshot.swift`](AgentDeviceRunner/AgentDeviceRunnerUITests/RunnerTests+Snapshot.swift) sets it. The daemon reads it in
  `resolveRunnerFatalReason` ([`runner-session.ts`](../../packages/apple-runner/src/runner-session.ts)).
- **Runner error codes** (for example `RUNNER_BUSY`, `RUNNER_WEDGED`, `MAIN_THREAD_TIMEOUT`). On the runner
  side, wire codes are declared in `RunnerWireErrorCode` ([`RunnerTests.swift`](AgentDeviceRunner/AgentDeviceRunnerUITests/RunnerTests.swift));
  `RUNNER_BUSY` and `RUNNER_WEDGED` come from the busy gate in
  [`RunnerTests+CommandDispatch.swift`](AgentDeviceRunner/AgentDeviceRunnerUITests/RunnerTests+CommandDispatch.swift), and `MAIN_THREAD_TIMEOUT` from
  the main-thread watchdog in [`RunnerTests+Transport.swift`](AgentDeviceRunner/AgentDeviceRunnerUITests/RunnerTests+Transport.swift). The daemon
  classifies a runner-reported code in `classifyRunnerReportedError`
  ([`runner-contract.ts`](../../packages/apple-runner/src/runner-contract.ts)): codes listed in `DIAGNOSTIC_ONLY_RUNNER_ERROR_CODES`
  arrive as `COMMAND_FAILED` with `details.runnerErrorCode`, unless their row names the wire code the
  caller already reads that family under. Other codes pass through as typed codes. A code with a
  `RUNNER_REPORTED_ERROR_REASONS` row also publishes `details.reason`, so a caller never reads the
  refusal off `message`. How the daemon reacts to a failure (retry, resend, session-fatal) is declared in
  `RUNNER_ERROR_RULES` and the helpers beside it
  ([`runner-error-classification.ts`](../../packages/apple-runner/src/runner-error-classification.ts)).
