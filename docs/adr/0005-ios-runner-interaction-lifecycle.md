# ADR 0005: iOS Runner Interaction Lifecycle

## Status

Accepted

Completed process history is in git history.

## Rules at a glance

- For iOS/macOS selector taps with a frame, use coordinate-first resolved element activation. tvOS remains focus/remote-driven.
- Before commands to ready sessions, probe `uptime`, except for the stated startup, readiness, and recent-mutation cases.
- Keep recent-mutation health only on the runner session and only for the stated app, commands, and 5-second window.
- Invalidate dead cached runner processes without graceful `shutdown`.
- After `RUNNER_BUSY`, resend only read-only commands under their busy-specific budget. Never replay mutations.
- Before a busy runner can enter retention, `close` stops it and awaits lease release.
- After a root AX failure, clear the cached app target. Keep raw/strict errors distinct from interactive recovery payloads.

## Context

The iOS runner is a long-lived XCTest process with an HTTP command loop.
A command can appear complete at the daemon boundary while XCTest already stops the runner.

This occurred in the React Navigation playground after selector taps that caused navigation, such as `Navigate to Details` and `Back to home`.
The runner resolved the button and synthesized the tap.
The app navigated, and XCTest then tried to resolve the original `XCUIElement` again.
Because the element had disappeared, xcodebuild recorded `Failed to get matching snapshot` and ended the test with `** TEST EXECUTE FAILED **`.
The daemon had already received a successful tap response.
Thus, the next read-only command used a stale cached runner.

These earlier assumptions were incorrect:

- A recent successful runner response proves continued runner health.
- After selector resolution, `XCUIElement.tap()` is the safest selector-tap primitive.
- A cached `XCUIApplication` target remains safe after XCTest cannot serialize the app's accessibility tree.

## Decision

Coordinate-first resolved element activation is the iOS/macOS selector-tap model.
The runner uses selectors or text queries to find the semantic `XCUIElement`.
If the element has a frame, activation taps its resolved center point instead of calling `XCUIElement.tap()`.
tvOS remains focus/remote-driven because it does not support normal coordinate input.

Before command send, ready runner sessions receive a short `uptime` preflight.
Read-only startup commands skip this preflight.
The first successful command proves readiness for a newly launched runner.
Readiness probe commands also skip preflight to avoid recursion.

The daemon may also skip ready-session `uptime` for an explicit allowlist of mutating interactions:

- `tap`.
- `longPress`.
- `drag`.
- `swipe`.
- `scroll`.
- `sequence`.

This requires a healthy mutating response from the same session for the same `appBundleId` within 5 seconds.
The response must parse successfully and carry no `runnerFatal`.
Only the `RunnerSession` object stores this recency as `lastHealthyMutation`.
Each invalidation or restart deletes it.
The record is written only after the `runnerFatal` check.
Sparse AX-fallback snapshots and `runnerFatal` payloads therefore never renew it.
Snapshots and other read-only responses never count as health signals.

This narrow skip is permitted because coordinate-first activation removes the command-induced teardown trigger.
The lifecycle status journal and status-before-invalidate recovery preserve status across teardown.
They resolve ambiguous post-send failures before invalidation.
After a skipped preflight, a transport failure clears recency and carries skip context.
Connection-shaped failures, such as refused, reset, or hung up, use status recovery instead of blind replay.
Timeout-shaped failures propagate with skip context.
This is the same classification used by preflighted sends.

`uptime` directly probes the runner listener.
The listener answers before command journaling, the serial execution queue, app activation, and main-thread XCTest dispatch.
It should measure only whether the runner is alive and accepts new HTTP requests.

Invalidate dead cached runner processes without graceful `shutdown`.
A stopped process cannot answer a shutdown request.
Graceful cleanup would only add stale-listener delay.

Every successful runner response carries live main-thread occupancy as `runnerMainThreadBusy`.
An execution-watchdog timeout carries typed code `MAIN_THREAD_TIMEOUT`.
Thus, the stalled command itself informs the daemon of occupancy before a later `RUNNER_BUSY` refusal.
The daemon mirrors occupancy on `RunnerSession`:

- Set it on `RUNNER_BUSY` or `MAIN_THREAD_TIMEOUT`.
- Clear it on any other served runner reply, which reached the main thread and therefore drained.
- Preserve it after a transport failure or unstamped recovered response.

A healthy `ok` never proves drain.
A private-AX snapshot can succeed while an abandoned tree crawl continues on the XCTest main thread (#2552).

The daemon's per-command read-only trait determines behavior after `RUNNER_BUSY`.
No runner-side command classification controls it.
`RUNNER_COMMAND_TRAITS` in `packages/platform-apple/src/runner/runner-command-traits.ts` owns this trait.
`runAppleRunnerCommand` reads it through `isReadOnlyRunnerCommand` when it selects the resend loop.
`runner-client-busy-resend.test.ts` asserts these distinct behaviors:

- A read-only command waits for drain under a busy-specific budget sized to outlast it.
  It resends until the runner answers or the window ends.
- A mutating command makes one attempt.
  The refusal reaches the caller without a wrapper or replay.

Neither path performs a status probe because the structured reply already states whether the command ran.
`runner-lifecycle.ts` implements this bypass.
The same trait controls the startup-preflight skip above.
It is therefore the single owner for classification changes.

If `close` would retain an occupied runner for reuse, it first stops that runner.
It awaits the stop so the lease is released before the next request.
A runner with watchdog-abandoned work refuses every command until drain or escalation to `RUNNER_WEDGED`.
This fact governs close and retention only.
The read-only resend loop is one live caller that waits under its own budget.
`close` does not inherit that wait for the pool.
Returning the stalled runner to the pool gives it to the next `open` without recovery.
Only process termination can abort uncancellable XCTest work.
This applies the `RUNNER_WEDGED` restart from #1105 at close instead of after the wedge threshold.

If XCTest reports a root accessibility snapshot failure such as `kAXErrorIllegalArgument`, the runner treats the cached app target as suspect.
Interactive snapshots fail closed with a truncated root-only payload.
They do not issue more flat fallback queries against the broken tree.
The runner clears the cached `XCUIApplication` handle.
The next command reacquires the target through normal activation.

An external iOS-family Simulator relaunch or physical iOS relaunch also invalidates process-bound target state.
After app process replacement, the daemon sends a lifecycle reset to the retained runner.
The next command then reacquires `XCUIApplication`.
The reset also clears process-bound snapshot penalty and private-AX depth state.
If the reset cannot be confirmed, the daemon discards the runner session.
If relaunch fails before reset, it also discards the session.
Other physical Apple OS leaves retain existing runner-restart behavior until separate evidence supports a change.

The snapshot surface intentionally has two AX-failure forms.
Interactive fast snapshots return truncated success with `runnerFatal`.
Agents can see AX unavailability and recover through a plain screenshot and coordinate navigation.
Raw or strict snapshot paths retain errors because their callers request a faithful tree instead of lossy recovery.

## Consequences

Selector taps that cause navigation no longer depend on XCTest's post-tap element resolution.
If navigation removes the target, the tap remains a normal successful interaction.
The runner should remain alive.

If xcodebuild exits for another reason, process/liveness checks detect the stale runner on the next command.
They avoid the old 15-second graceful-shutdown wait.
Remaining latency comes from fresh xcodebuild runner startup instead of stale transport delay.

A `close` then `open` during abandoned main-thread work starts a fresh runner instead of reusing the stalled runner.
The wedge therefore does not persist across close/open.
When retention is requested, ready runners without unanswered exchanges can remain active for reuse.
iOS-family simulators also require an observed live listener.
Close retires unfinished startup and its recovery authority.
The retained generation owns its idle timer and listener observation.
Successful reuse ends retention.
Listener loss or idle expiry disposes that generation.
Graceful daemon shutdown stops idle retained generations before exit.
Active ready generations retain the existing handoff policy.

The daemon does not treat generic recent success as runner health.
A proven healthy mutating response for the same app provides end-to-end liveness evidence from HTTP listener to app target.
It counts only after the `runnerFatal` check and only for allowlisted interactions.
A repeated series of allowlisted interactions can therefore skip per-command `uptime`.
Each healthy mutation establishes permission for the next skip.
Unconditional `uptime` remains the default for non-allowlisted commands and after:

- Invalidation.
- A stale record.
- An app-bundle change.
- An absent record.

XCTest may still be unable to examine deeply an app with a broken accessibility tree.
However, one failed snapshot no longer causes continued use of a suspect target or additional failures from every interactive element query.

After a tap, `XCTEST_RECORDED_FAILURE` is an ambiguous outcome at the daemon boundary.
If a usable retained snapshot exists, the daemon takes one same-presentation post-action capture.
A changed accessibility digest returns success with an explicit warning.
This prevents blind repetition of a tap that may already have navigated.
Unchanged, sparse, mismatched, or unavailable evidence retains the original failure.

iOS-family Simulator and physical iOS relaunch retain a healthy XCTest process without retaining an app target across process identity.
The reset adds one local runner request instead of a runner restart.
Before replacement target acquisition, it clears the old process's hostile-screen capture penalty.
