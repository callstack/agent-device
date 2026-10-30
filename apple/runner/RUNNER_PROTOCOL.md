# iOS Runner Protocol

The Apple runner speaks a small internal HTTP+JSON protocol between the TypeScript daemon and the XCUITest host. This protocol is a maintainer document, not part of the public user docs, but it should stay explicit so the TypeScript and Swift sides do not drift.

## Transport

- Endpoint: `POST /command`
- Content type: `application/json`
- Request body: one JSON command object
- Response body: one JSON envelope
- One request per connection; every response carries `Connection: close`.

The daemon sends to `http://127.0.0.1:<port>/command` for simulator and macOS runners. A physical device is reached over usbmux when cabled, otherwise at its CoreDevice tunnel address; it is never dialed at this Mac's loopback.

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
    "code": "UNSUPPORTED_OPERATION",
    "message": "Unable to dismiss the iOS keyboard: the keyboard exposes no dismiss key (background taps are never attempted)"
  }
}
```

`data` is command-specific. Common fields include snapshot nodes, text lookup results, gesture timing, visibility metadata, and screenshot or recording output details.

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
  arrive as `COMMAND_FAILED` with `details.runnerErrorCode`, and other codes pass through as typed
  codes. How the daemon reacts to a failure (retry, resend, session-fatal) is declared in
  `RUNNER_ERROR_RULES` and the helpers beside it
  ([`runner-error-classification.ts`](../../packages/apple-runner/src/runner-error-classification.ts)).
