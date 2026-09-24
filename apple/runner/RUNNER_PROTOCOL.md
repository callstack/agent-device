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

The current command names are defined in:

- [`../../packages/platform-apple/src/runner/runner-contract.ts`](../../packages/platform-apple/src/runner/runner-contract.ts) — the `RunnerCommand` union (TypeScript side)
- [`AgentDeviceRunner/AgentDeviceRunnerUITests/RunnerTests+Models.swift`](AgentDeviceRunner/AgentDeviceRunnerUITests/RunnerTests+Models.swift) — the `CommandType` enum (Swift side)

Per-command behavior the daemon keys on (read-only vs. mutating, whether a command is a readiness
probe, whether it is exempt from or eligible to skip the readiness preflight) is declared once, as
data, in
[`../../packages/platform-apple/src/runner/runner-command-traits.ts`](../../packages/platform-apple/src/runner/runner-command-traits.ts)
(`RUNNER_COMMAND_TRAITS`). Read that table instead of inferring traits from a command's name.

## Recovery: `commandId`, the Command Journal, and `status`

Every non-`status` request the daemon sends carries a `commandId` (`withRunnerCommandId` in
[`runner-contract.ts`](../../packages/platform-apple/src/runner/runner-contract.ts)). The runner
records each command's lifecycle — `accepted` → `started` → `completed`/`failed` — under that id in
an in-memory journal
([`RunnerCommandJournal`](AgentDeviceRunner/AgentDeviceRunnerUITests/RunnerTests+CommandJournal.swift)),
which also retains the completed response body for most commands (not `snapshot`/`screenshot`,
whose payloads are too large to retain).

If the daemon loses the transport response to a command (socket error, timeout), it does not blindly
resend a mutation. It sends a follow-up request with `command: "status"` and `statusCommandId` set to
the original command's id
([`executeStatus`](AgentDeviceRunner/AgentDeviceRunnerUITests/RunnerTests+CommandDispatch.swift)),
reads back the journaled lifecycle state, and decides from that state alone whether to return the
retained response, treat the command as still in flight, treat it as failed, or give up and invalidate
the session. That decision logic lives in one place:
[`../../packages/platform-apple/src/runner/runner-command-recovery.ts`](../../packages/platform-apple/src/runner/runner-command-recovery.ts).

## `runnerFatal` and `runnerMainThreadBusy` response fields

Both are optional booleans on `data`
([`DataPayload`](AgentDeviceRunner/AgentDeviceRunnerUITests/RunnerTests+Models.swift)):

- `runnerFatal` (plus `runnerFatalReason`) marks a response whose failure means the runner session
  itself is no longer trustworthy (for example, an AX snapshot the private backend cannot recover
  from). The daemon reads it with `resolveRunnerFatalReason` /
  `resolveRunnerFatalErrorReason` in
  [`runner-error-classification.ts`](../../packages/platform-apple/src/runner/runner-error-classification.ts)
  and invalidates the cached session instead of reusing it.
- `runnerMainThreadBusy` is stamped only on `ok: true` responses, by the transport that writes them
  (`stampingCurrentMainThreadBusy` in
  [`RunnerTests+Transport.swift`](AgentDeviceRunner/AgentDeviceRunnerUITests/RunnerTests+Transport.swift),
  reading watchdog-abandoned-work state from
  [`runMainThreadWork`/`runMainThreadWorkIfIdle`](AgentDeviceRunner/AgentDeviceRunnerUITests/RunnerTests+MainThreadWork.swift)).
  A capture can succeed off a side channel (e.g. private-AX) while an abandoned tree crawl still
  grinds, so `ok: true` alone does not mean the runner has drained — that is what the stamp is for.
  A failure carries no stamp; on failure the daemon instead reads occupancy from `error.code`
  (`RUNNER_BUSY` or `MAIN_THREAD_TIMEOUT` mark the session busy, any other structured failure marks
  it not-busy — see `isRunnerMainThreadOccupiedError` in `runner-session.ts`), and a journal-replayed
  `status` response carries no stamp either way. A response with no stamp and no occupancy-bearing
  error code leaves the session's prior `runnerMainThreadBusy` value untouched rather than clearing
  it.

## Typed Runner Error Codes

These are the runner's own vocabulary: on the wire they still arrive as `ok: false` with
`error.code` set to one of them, and the daemon reads `error.code` through one classifier,
[`classifyRunnerReportedError`](../../packages/platform-apple/src/runner/runner-contract.ts), which
either passes typed daemon-facing families through (e.g. `RUNNER_WEDGED` → `AppError` code
`RUNNER_WEDGED`) or keeps a code diagnostic-only (`COMMAND_FAILED` + `details.runnerErrorCode`) per
the `DIAGNOSTIC_ONLY_RUNNER_ERROR_CODES` map in the same file. Never match on `error.message`.

`RUNNER_ERROR_RULES` in `runner-error-classification.ts` has a row for exactly three codes, and
only these three carry a typed retry/session-fatal reaction:

- `RUNNER_BUSY` — produced when a new command arrives while abandoned main-thread work (past the
  execution watchdog, still below the wedge threshold) is draining (`runnerBusyResponse` in
  [`RunnerTests+CommandDispatch.swift`](AgentDeviceRunner/AgentDeviceRunnerUITests/RunnerTests+CommandDispatch.swift)).
  The daemon resends a read-only command across the drain window (`RUNNER_BUSY_RESEND_ATTEMPTS` in
  [`runner-client.ts`](../../packages/platform-apple/src/runner/runner-client.ts)); a mutating
  command is not resent — it surfaces the refusal.
- `RUNNER_WEDGED` — produced when abandoned main-thread work has outlived the wedge threshold, so a
  restart rather than waiting is the only cure (`runnerWedgedResponse`, same file). The daemon
  treats this as session-fatal (`resolveRunnerFatalErrorReason` → `runner_main_thread_wedged` in
  [`runner-error-classification.ts`](../../packages/platform-apple/src/runner/runner-error-classification.ts));
  the session is invalidated and the runner is restarted.
- `MAIN_THREAD_TIMEOUT` — produced when the command that itself tripped the execution watchdog
  finally gets its (abandoned) dispatch's failure written as its response
  (`commandFailedResponse` in
  [`RunnerTests+Transport.swift`](AgentDeviceRunner/AgentDeviceRunnerUITests/RunnerTests+Transport.swift),
  using `RunnerWireErrorCode.mainThreadTimeout` from
  [`RunnerTests.swift`](AgentDeviceRunner/AgentDeviceRunnerUITests/RunnerTests.swift)) — distinct
  from a later command instead meeting a fast `RUNNER_BUSY` refusal. The daemon does not retry the
  command that returned it (its wait already elapsed); `isRunnerMainThreadOccupiedError` still marks
  the session busy so the next read's preflight/resend logic accounts for the drain.

Every other runner-reported code the daemon currently keys on —
`APP_NOT_RUNNING`, `ALERT_NOT_FOUND`, `SCROLL_KEYBOARD_OCCLUDES_SURFACE`, and the three
`APP_SCREEN_*` capture-refusal codes — stays diagnostic-only (`COMMAND_FAILED` +
`details.runnerErrorCode`) and is not in `RUNNER_ERROR_RULES`. Their wire class is declared in
[`DIAGNOSTIC_ONLY_RUNNER_ERROR_CODES`](../../packages/platform-apple/src/runner/runner-contract.ts),
and the reaction to each lives with its owner, not here: `APP_NOT_RUNNING` (an iOS-only read
refusal; `#if os(iOS)`) carries `details.retriable`, which a caller's own polling `wait` reads to
decide whether to try again — never a resend keyed on the code itself, `ALERT_NOT_FOUND`'s
poll-and-retry sits in
[`alert.ts`](../../packages/platform-apple/src/alert.ts) (`awaitAppleAlert`/`actOnAppleAlert`, which
keep polling while `isAlertNotFoundError` holds and attach a fallback hint once the window is
exhausted), `SCROLL_KEYBOARD_OCCLUDES_SURFACE`'s refusal sits in
[`core/scroll.ts`](../../packages/platform-apple/src/core/scroll.ts), and the `APP_SCREEN_*` codes
are produced from
[`RunnerAppScreenCapture.swift`](AgentDeviceRunner/AgentDeviceRunnerUITests/RunnerAppScreenCapture.swift)
and fail their capture closed rather than falling back to an unintended screen. Never re-list a
code's behavior here — `DIAGNOSTIC_ONLY_RUNNER_ERROR_CODES` and `RUNNER_ERROR_RULES` in
`runner-error-classification.ts` are the source of truth; re-derive from there before relying on
this doc.

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
