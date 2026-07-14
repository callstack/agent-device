# ADR 0005: iOS Runner Interaction Lifecycle

## Status

Accepted

## Context

The iOS runner is a long-lived XCTest process with an HTTP command loop. A command can appear to
complete at the daemon boundary while XCTest is already tearing down the test runner.

This was reproduced in the React Navigation playground with navigation-causing selector taps such
as `Navigate to Details` and `Back to home`. The runner resolved the button and synthesized the tap,
the app navigated, and then XCTest tried to re-resolve the original `XCUIElement`. Because the
element had disappeared, xcodebuild recorded `Failed to get matching snapshot` and ended the test
with `** TEST EXECUTE FAILED **`. The daemon had already received a successful tap response, so the
next read-only command inherited a stale cached runner.

Two older assumptions were wrong:

- A recent successful runner response proves the runner is still healthy.
- `XCUIElement.tap()` is the safest selector-tap primitive once a selector has resolved.
- A cached `XCUIApplication` target remains safe after XCTest reports that the app's accessibility
  tree cannot be serialized.

## Decision

Coordinate-first resolved element activation is the iOS/macOS selector-tap model. The runner still
uses selectors or text queries to find the semantic `XCUIElement`, but when the element has a frame,
activation taps the resolved center point instead of calling `XCUIElement.tap()`. tvOS remains
focus/remote-driven because tvOS does not support normal coordinate input.

Ready runner sessions are probed with a short `uptime` preflight before command send. Read-only
startup commands still skip that preflight because the first successful command is the readiness
proof for a newly launched runner. Readiness probe commands skip preflight to avoid recursion.

The daemon may additionally skip the ready-session `uptime` preflight for an explicit allowlist of
mutating interactions (`tap`, `longPress`, `drag`, `swipe`, `scroll`, `sequence`) when the same
session produced a healthy mutating response — parsed ok and not carrying `runnerFatal` — for the
same `appBundleId` within 5 seconds. This recency lives only on the `RunnerSession` object as
`lastHealthyMutation`, so it dies with every invalidation/restart, and it is recorded only after the
`runnerFatal` check, so sparse AX-fallback snapshots and `runnerFatal` payloads never refresh it.
Snapshots and other read-only responses never count as a health signal. This narrow skip is
permitted now because the future-work precondition below is met: coordinate-first activation removed
the command-induced teardown trigger, and the lifecycle status journal plus the status-before-
invalidate recovery is the teardown-surviving status surface that resolves any ambiguous post-send
failure before invalidation. A transport failure after a skip clears the recency record and is marked
with the skip context; connection-shaped failures (refused, reset, hung up) run status recovery
instead of a blind replay, while timeout-shaped failures propagate with the skip context (the same
classification preflighted sends use).

`uptime` is a direct runner listener probe. It is answered before command journaling, the serial
command execution queue, app activation, and main-thread XCTest dispatch. It should measure only
whether the runner is alive and accepting new HTTP requests.

Dead cached runner processes are invalidated without graceful `shutdown`. A process that already
stopped cannot answer the shutdown request, so graceful cleanup only adds stale-listener delay.

When XCTest reports a root accessibility snapshot failure such as `kAXErrorIllegalArgument`, the
runner treats the cached app target as suspect. Interactive snapshots fail closed to a truncated
root-only payload instead of issuing more flat fallback queries against the same broken tree, and
the cached `XCUIApplication` handle is cleared so the next command reacquires the target through the
normal activation path.

An external iOS simulator relaunch also invalidates process-bound target state. After replacing the
app process, the daemon sends a lifecycle reset to the retained runner so the next command reacquires
`XCUIApplication`; if that reset cannot be confirmed, the daemon discards the runner session.

The snapshot surface intentionally has two AX-failure shapes. Interactive fast snapshots return a
truncated success payload with `runnerFatal` so agents can still see that AX state is unavailable
and recover with a plain screenshot plus coordinate navigation. Raw or strict snapshot paths keep
returning an error because those callers requested a faithful tree, not a lossy recovery payload.

## Consequences

Navigation-causing selector taps no longer couple command success to XCTest's post-tap element
bookkeeping. If the target disappears because navigation happened, the tap remains a normal
successful interaction and the runner should stay alive.

If xcodebuild still exits for another reason, the next command detects the stale runner through
process/liveness checks and avoids the old 15-second graceful-shutdown wait. The remaining latency is
fresh xcodebuild runner startup, not a stale transport stall.

The daemon no longer models a generic "recent success" cache as a runner-health signal. A proven
healthy mutating response for the same app — recorded only after the `runnerFatal` check and only
for allowlisted interactions — is now a real end-to-end liveness proof (HTTP listener through to the
app target), so a hot loop of allowlisted interactions skips the per-command `uptime` request while
still re-earning each skip from another healthy mutation. The earlier unconditional `uptime` before
every ready-session command remains the default for non-allowlisted commands and after any
invalidation, stale record, app-bundle change, or absent record.

Apps with broken accessibility trees may still be impossible for XCTest to inspect deeply, but one
failed snapshot no longer teaches the runner to keep using a suspect cached app target or to amplify
the failure by walking every interactive element query.

Simulator relaunch keeps the healthy XCTest process warm without carrying an app target across
process identity. The reset adds one local runner request instead of paying for a runner restart.

Future optimization work should only reduce these preflights after the runner exposes status in a
way that survives command-induced XCTest teardown and can prove the session is still serving new
requests.
