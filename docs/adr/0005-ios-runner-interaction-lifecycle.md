# ADR 0005: iOS Runner Interaction Lifecycle

## Status

Accepted

## Rules at a glance

- For iOS/macOS selector taps on an element with a frame, use coordinate-first resolved element activation. tvOS remains focus/remote-driven.
- Before a command to a ready session, send an `uptime` preflight, except for the stated startup, readiness, exempt-command, and recent-mutation cases.
- Keep recent-mutation health only on the `RunnerSession` and only for the stated app, commands, response checks, and 5-second window.
- Never count snapshots or other read-only responses as health signals.
- Future optimization work should reduce the `uptime` preflights only after runner status survives command-induced XCTest teardown and can prove that the session still serves new requests.
- Invalidate dead cached runner processes without graceful `shutdown`.
- After `RUNNER_BUSY`, resend only read-only commands, under their busy-specific budget.
- After `RUNNER_BUSY` on a mutating command, return the refusal to the caller without a resend.
- Let the runner's command journal decide once per `commandId` whether a send executes, joins the running execution, or is answered from the recorded outcome, and register a joining send for that answer inside the same decision.
- Never execute a `commandId` twice within one runner process, never evict a journal entry whose execution has not finished, and keep the fact that a spent `commandId` was spent after its entry is pruned. The kept fact is released only by a memory safety valve; see the admission rule below for its bound.
- If `close` would retain a runner whose main-thread occupancy is set, stop that runner first and await the stop.
- After a root AX failure, clear the cached app target. Keep raw/strict errors distinct from interactive recovery payloads.

## Context

The iOS runner is a long-lived XCTest process with an HTTP command loop.
A command can appear to complete at the daemon boundary while XCTest is already tearing down the test runner.

This failure was reproduced in the React Navigation playground with selector taps that cause navigation, such as `Navigate to Details` and `Back to home`.
The runner resolved the button and synthesized the tap.
The app navigated, and XCTest then tried to resolve the original `XCUIElement` again.
Because the element had disappeared, xcodebuild recorded `Failed to get matching snapshot` and ended the test with `** TEST EXECUTE FAILED **`.
The daemon had already received a successful tap response.
Thus, the next read-only command inherited a stale cached runner.

These earlier assumptions were incorrect:

- A recent successful runner response proves that the runner is still healthy.
- After a selector has resolved, `XCUIElement.tap()` is the safest selector-tap primitive.
- A cached `XCUIApplication` target remains safe after XCTest reports that it cannot serialize the app's accessibility tree.

## Decision

Coordinate-first resolved element activation is the iOS/macOS selector-tap model.
The runner still uses selectors or text queries to find the semantic `XCUIElement`.
If the element has a frame, activation taps the resolved center point instead of calling `XCUIElement.tap()`.
tvOS remains focus/remote-driven because tvOS does not support normal coordinate input.

Before command send, ready runner sessions receive a short `uptime` preflight.
Read-only startup commands still skip that preflight because, for a newly launched runner, the first successful command is the readiness proof.
Readiness probe commands skip preflight to avoid recursion.
A ready session also skips the preflight for the preflight-exempt commands `activate`, `terminate`, and `targetReset` (`readinessPreflightExempt` in `RUNNER_COMMAND_TRAITS`).

The daemon may also skip the ready-session `uptime` preflight for an explicit allowlist of mutating interactions:

- `tap`.
- `longPress`.
- `drag`.
- `swipe`.
- `scroll`.
- `desktopScroll`.
- `gesture`.
- `sequence`.

The skip requires that the same session produced a healthy mutating response for the same `appBundleId` within 5 seconds.
A healthy mutating response is parsed ok and does not carry `runnerFatal`.
This recency lives only on the `RunnerSession` object as `lastHealthyMutation`.
Thus, it is discarded with every invalidation or restart.
The record is written only after the `runnerFatal` check.
Thus, sparse AX-fallback snapshots and `runnerFatal` payloads never refresh it.
Snapshots and other read-only responses never count as a health signal.

This narrow skip is permitted now, because the preflight-reduction precondition in the Consequences section is met:

- Coordinate-first activation removed the command-induced teardown trigger.
- The lifecycle status journal plus the status-before-invalidate recovery is the teardown-surviving status surface.
  That surface resolves any ambiguous post-send failure before invalidation.

After a skip, a transport failure clears the recency record and is marked with the skip context.
Connection-shaped failures (refused, reset, hung up) run status recovery instead of a blind replay.
Timeout-shaped failures propagate with the skip context.
This is the same classification that preflighted sends use.

`uptime` is a direct runner listener probe.
The listener answers it before command journaling, the serial command execution queue, app activation, and main-thread XCTest dispatch.
The `uptime` probe should measure only whether the runner is alive and accepts new HTTP requests.

Dead cached runner processes are invalidated without graceful `shutdown`.
A process that already stopped cannot answer the shutdown request.
Thus, graceful cleanup only adds stale-listener delay.

The runner stamps its live main-thread occupancy (`runnerMainThreadBusy`) onto every successful response.
The runner tags the execution-watchdog timeout with the typed `MAIN_THREAD_TIMEOUT` code.
Thus, the daemon learns of main-thread occupancy from the stalling command itself, not only from a later `RUNNER_BUSY` refusal.
The daemon mirrors that occupancy on the `RunnerSession`:

- `RUNNER_BUSY` or `MAIN_THREAD_TIMEOUT` sets it.
- Any other served runner reply clears it, because that reply reached the main thread and therefore drained.
- A transport failure or an unstamped recovered response leaves it intact.

The daemon never reads a healthy `ok` as proof of drain.
The reason is that a private-AX snapshot can be served while an abandoned tree crawl still continues on the XCTest main thread (#2552).

The cost of a `RUNNER_BUSY` refusal to the caller depends on the daemon's own per-command read-only trait.
It does not depend on any runner-side classification of the command.
The trait is `RUNNER_COMMAND_TRAITS` in `packages/apple-runner/src/runner-command-traits.ts`.
`runAppleRunnerCommand` reads it through `isReadOnlyRunnerCommand` when it decides whether to wrap the send in a resend loop.
This asymmetry is shipped, and `runner-client-busy-resend.test.ts` asserts it:

- A read-only command treats the refusal as *not yet*.
  It waits for the drain on the busy-specific budget sized to outlast the drain.
  It resends until the runner answers or the window ends.
- A mutating command treats the same refusal as *not mine to send again*.
  It makes one attempt, and the refusal reaches the caller unwrapped, with nothing replayed.

Neither path sends a status probe, because a structured reply already answered "did my command run?".
This bypass is in `runner-lifecycle.ts`.
The same trait already decides the startup-preflight skip above.
Thus, it is the single place for a change to that classification.

`RunnerCommandJournal` owns command admission, and the transport asks it once per inbound request.
Its verdict is `execute`, `join`, or `terminal`:

- `execute` claims the `commandId`, and that send owns the one execution.
- `join` means an execution is claimed and unfinished. The journal registers that send as a waiter of the execution in the same locked operation, which keeps a transport retry from stacking a second execution behind the first (#1105). Settling and registering are one operation because a close between them left the send waiting on a delivery that had already gone out.
- `terminal` means execution ended after dispatch. The runner answers with the outcome it recorded, which may be a failure, and the command never runs again.

The journal closes a `commandId` at the last fast `RUNNER_BUSY` or `RUNNER_WEDGED` refusal, not at accept.
A refusal before that point closed its entry as `failed` but dispatched nothing, so the `commandId` stays reusable and the read-only busy resend above can still run under it.
Answering a closed `commandId` uses the retained response, then the retained error, then the typed `COMMAND_ALREADY_FINISHED` refusal for a command whose own classification retains no body.
That refusal is a structured failure the daemon does not retry. Its dispatch disclosure stays `unknown`: the runner will not re-run the command, and only the runner knows whether an earlier send of that id reached the device.
That refusal also reports nothing about the runner's main thread. The journal wrote it without executing, so the runner may be idle or mid-drain and the refusal cannot say which. The daemon's occupancy rule has three readings, occupied, drained, and this one, silent, and only the first two write `runnerMainThreadBusy`; a repeat refused while abandoned work drains must leave that report standing, because retention and handoff act on it.

Pruning drops only closed entries, so a queued or executing command always stays queryable.
When a closed entry that dispatched is pruned, the journal keeps its id in a separate closed-id window, because a bare id carries no outcome body.
A resend inside that window is answered with the typed refusal; `status` still answers `notAccepted` for it, because only the entry can report an outcome.
An id the runner refused before dispatch is left free, which is what the read-only busy resend depends on.
`status` answers `notAccepted` only for an id the journal does not hold.
The daemon cannot read `notAccepted` as a safe terminal state, so evicting a running command would push it to invalidate a session whose runner is still executing that command.
The closed-id window holds 4096 ids, 64x the entry window, and it is a memory safety valve, not an admission boundary. Its residual bound, accepted here: within one runner process, a spent id is refused for the whole window, and the valve releases only the oldest id, so a resend arriving more than 4096 completed dispatches after a command can re-execute it. The resends this bound speaks of are lost-response resends of a dispatched command: a read-only `RUNNER_BUSY` resend reuses a `commandId` the runner refused before dispatch, and such an id never enters the window, so no chain of refusals can consume it. A runner restart starts a new journal, which answers `notAccepted` for every id; a replay across a runner replacement is governed by charge settlement, not by this window.
A watermark over issued ids was rejected: the daemon mints `commandId` as a random UUID per request, reuses one id across retries and across runner generations, and persists nothing, so no ordering exists to compare.
Eviction on a daemon resend deadline was rejected: the daemon holds no per-id "never resend after this instant" value — its resend budgets are attempt counts and per-exchange timeouts redrawn per attempt, and a restart-and-replay can legitimately post the same id minutes later — so a deadline-based rule would need a wire-contract change this change does not make.

Rejected: gating re-admission on the runner's read-only classification. That would replay a finished `snapshot` after its caller already received the answer, which is not the same command's first execution.

Rejected: keeping the transport's own in-flight id set beside the journal. Two records of one lifecycle drifted: the set was cleared when the answer was delivered while the journal still held the entry, so a repeat arriving in that window was admitted and executed again.

If `close` would retain a runner for reuse and that occupancy is set, `close` first stops the runner.
`close` awaits the stop, so the lease is released before the next request.
A runner that still finishes watchdog-abandoned work refuses every command sent to it until it drains or escalates to `RUNNER_WEDGED`.
This ADR states that fact only for the close-and-pooling decision.
The read-only resend above is one live caller that waits out the same refusal on its own budget.
`close` does not inherit that wait on behalf of the pool.
If the pool takes the stalled runner back, it gives that runner to the next `open`, and `close` recovers nothing.
Killing the process is the only way to abort uncancellable XCTest work.
This is the `RUNNER_WEDGED` restart from #1105, applied at the close boundary instead of after the wedge threshold elapses.

If XCTest reports a root accessibility snapshot failure such as `kAXErrorIllegalArgument`, the runner treats the cached app target as suspect.
Interactive snapshots fail closed to a truncated root-only payload.
They do not issue more flat fallback queries against the same broken tree.
The runner clears the cached `XCUIApplication` handle.
Thus, the next command reacquires the target through the normal activation path.

An external iOS-family Simulator relaunch or physical iOS relaunch also invalidates process-bound target state.
After it replaces the app process, the daemon sends a lifecycle reset to the retained runner.
Thus, the next command reacquires `XCUIApplication`.
The reset also clears process-bound snapshot penalty and private-AX depth state.
If that reset cannot be confirmed, or if relaunch fails before reset, the daemon discards the runner session.
Other physical Apple OS leaves retain their existing runner-restart behavior until separate evidence exists.

The snapshot surface intentionally has two AX-failure shapes.
Interactive fast snapshots return a truncated success payload with `runnerFatal`.
Thus, agents can still see that AX state is unavailable and recover with a plain screenshot plus coordinate navigation.
Raw or strict snapshot paths continue to return an error, because those callers requested a faithful tree, not a lossy recovery payload.

## Consequences

The success of a selector tap that causes navigation no longer depends on XCTest's post-tap element bookkeeping.
If the target disappears because navigation happened, the tap remains a normal successful interaction.
The runner should stay alive.

If xcodebuild still exits for another reason, the next command detects the stale runner through process/liveness checks.
That command also avoids the old 15-second graceful-shutdown wait.
The remaining latency is fresh xcodebuild runner startup, not a stale transport stall.

A `close` then `open` on a runner that still drains abandoned main-thread work now starts a fresh runner.
It does not inherit the stalled runner.
Thus, the wedge no longer survives the close/open cycle.
When retention is requested, runners that are ready and have no unanswered exchanges can remain warm.
iOS-family simulators also require an observed live listener.
Close retires unfinished startup and its recovery authority.
The retained generation owns its idle timer and listener observation.
Successful reuse ends retention.
Listener loss or idle expiry disposes that generation.
Graceful daemon shutdown stops idle retained generations before it exits.
Active ready generations retain the existing handoff policy.

The daemon no longer models a generic "recent success" cache as a runner-health signal.
A proven healthy mutating response for the same app is now a real end-to-end liveness proof, from the HTTP listener through to the app target.
That response is recorded only after the `runnerFatal` check and only for allowlisted interactions.
Thus, a repeated series of allowlisted interactions skips the per-command `uptime` request.
Each skip is still earned again from another healthy mutation.
The earlier unconditional `uptime` before every ready-session command remains the default for non-allowlisted commands and after any of these:

- Invalidation.
- A stale record.
- An app-bundle change.
- An absent record.

XCTest may still be unable to examine deeply an app with a broken accessibility tree.
However, one failed snapshot no longer causes the runner to keep using a suspect cached app target.
It also no longer causes the runner to amplify the failure with a walk of every interactive element query.

An `XCTEST_RECORDED_FAILURE` returned after a tap is treated as an ambiguous outcome at the daemon boundary.
If a usable retained snapshot exists, the daemon takes one same-presentation post-action capture.
A changed accessibility digest is reported as success with an explicit warning.
Thus, agents do not blindly repeat a tap that may already have navigated.
Unchanged, sparse, mismatched, or unavailable evidence remains the original failure.

iOS-family Simulator and physical iOS relaunch keep the healthy XCTest process warm without carrying an app target across process identity.
The reset adds one local runner request instead of the cost of a runner restart.
Before the replacement target is reacquired, the reset clears the old process's hostile-screen capture penalty.

Future optimization work should reduce these `uptime` preflights only after the runner exposes status that survives command-induced XCTest teardown and can prove that the session still serves new requests.
