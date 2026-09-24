# iOS Runner Protocol

The Apple runner speaks a small internal HTTP+JSON protocol between the TypeScript daemon and the XCUITest host. This protocol is a maintainer document, not part of the public user docs, but it should stay explicit so the TypeScript and Swift sides do not drift.

## Transport

- Endpoint: `POST /command`
- Content type: `application/json`
- Request body: one JSON command object
- Response body: one JSON envelope

The daemon probes `http://127.0.0.1:<port>/command` for simulator and desktop flows, and can use a tunneled device address for physical iOS/tvOS devices before falling back to localhost.

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

- `RunnerCommand` in [`../../packages/platform-apple/src/runner/runner-contract.ts`](../../packages/platform-apple/src/runner/runner-contract.ts)
- `RUNNER_COMMAND_TRAITS` in [`../../packages/platform-apple/src/runner/runner-command-traits.ts`](../../packages/platform-apple/src/runner/runner-command-traits.ts)
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
  ([`runner-contract.ts`](../../packages/platform-apple/src/runner/runner-contract.ts)). The runner records commands in
  `RunnerCommandJournal` ([`RunnerTests+CommandJournal.swift`](AgentDeviceRunner/AgentDeviceRunnerUITests/RunnerTests+CommandJournal.swift)) and
  answers the `status` command in `executeStatus`
  ([`RunnerTests+CommandDispatch.swift`](AgentDeviceRunner/AgentDeviceRunnerUITests/RunnerTests+CommandDispatch.swift)). The daemon's recovery
  decisions live in [`runner-command-recovery.ts`](../../packages/platform-apple/src/runner/runner-command-recovery.ts).
- **`runnerMainThreadBusy`.** The runner stamps successful responses with `stampingCurrentMainThreadBusy`
  ([`RunnerTests+Models.swift`](AgentDeviceRunner/AgentDeviceRunnerUITests/RunnerTests+Models.swift)) from `currentMainThreadBusyState()`
  ([`RunnerTests+MainThreadWork.swift`](AgentDeviceRunner/AgentDeviceRunnerUITests/RunnerTests+MainThreadWork.swift)), applied in `jsonResponse`
  ([`RunnerTests+Transport.swift`](AgentDeviceRunner/AgentDeviceRunnerUITests/RunnerTests+Transport.swift)). The daemon reads the stamp in [`runner-session.ts`](../../packages/platform-apple/src/runner/runner-session.ts).
- **`runnerFatal`.** A field of the response data (`runnerFatal` in
  [`RunnerTests+Models.swift`](AgentDeviceRunner/AgentDeviceRunnerUITests/RunnerTests+Models.swift)); for example, a sparse snapshot payload in
  [`RunnerTests+Snapshot.swift`](AgentDeviceRunner/AgentDeviceRunnerUITests/RunnerTests+Snapshot.swift) sets it. The daemon reads it in
  `resolveRunnerFatalReason` ([`runner-session.ts`](../../packages/platform-apple/src/runner/runner-session.ts)).
- **Runner error codes** (for example `RUNNER_BUSY`, `RUNNER_WEDGED`, `MAIN_THREAD_TIMEOUT`). On the runner
  side, wire codes are declared in `RunnerWireErrorCode` ([`RunnerTests.swift`](AgentDeviceRunner/AgentDeviceRunnerUITests/RunnerTests.swift));
  `RUNNER_BUSY` and `RUNNER_WEDGED` come from the busy gate in
  [`RunnerTests+CommandDispatch.swift`](AgentDeviceRunner/AgentDeviceRunnerUITests/RunnerTests+CommandDispatch.swift), and `MAIN_THREAD_TIMEOUT` from
  the main-thread watchdog in [`RunnerTests+Transport.swift`](AgentDeviceRunner/AgentDeviceRunnerUITests/RunnerTests+Transport.swift). The daemon
  classifies a runner-reported code in `classifyRunnerReportedError`
  ([`runner-contract.ts`](../../packages/platform-apple/src/runner/runner-contract.ts)): codes listed in `DIAGNOSTIC_ONLY_RUNNER_ERROR_CODES`
  arrive as `COMMAND_FAILED` with `details.runnerErrorCode`, and other codes pass through as typed
  codes. How the daemon reacts to a failure (retry, resend, session-fatal) is declared in
  `RUNNER_ERROR_RULES` and the helpers beside it
  ([`runner-error-classification.ts`](../../packages/platform-apple/src/runner/runner-error-classification.ts)).
