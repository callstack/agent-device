# ADR 0002: Persistent Platform Helper Sessions

## Status

Accepted

Completed process history is in git history.

> **Amended by [ADR 0019](0019-request-bound-platform-runtime.md).** Persistent protocols, invalidation, and explicitly safe one-shot fallback remain accepted.
> The daemon owns helper lifetime policy.
> Platform modules own process-lived helper managers and helper mechanics.
> Request bindings attach to healthy helper generations but never own or stop them.

## Rules at a glance

- When startup costs are high and an automation context is reusable, use persistent platform helper sessions.
- The daemon owns lifetime policy. Platform modules own helper-manager mechanics.
- Unless an explicit cache contract applies, helpers must execute each command against fresh platform state.
- Keep Android snapshots and touch commands in one bundled automation helper.
- For Android, retry one-shot only for idempotent reads after the failed session stops.
- For Android, do not retry gesture injection after a session failure.
- If the packaged Android helper is unavailable or invalid, agent-device must fail closed.

## Context

Some platform automation backends have high startup costs but low reuse costs.
iOS already uses a long-lived XCTest runner session with an HTTP transport.
This model avoids repeated `xcodebuild`, runner boot, and XCTest readiness costs for each command.
The daemon can still invalidate the runner when the device, app, bundle, or runner process changes.

Android snapshot capture initially used a one-shot instrumentation helper.
Each snapshot performed these operations:

1. Start `adb shell am instrument`.
2. Connect `UiAutomation`.
3. Capture the tree.
4. Emit XML.
5. Exit.

Recent Android snapshot optimizations reduced XML size, idle waits, extra file I/O, and work on hidden content hints.
However, a disposable prototype showed that process/session startup dominates steady-state latency:

- Launcher snapshot: one-shot p50 `227ms`, persistent socket p50 `5.8ms`.
- React Navigation playground snapshot: one-shot p50 `265.7ms`, persistent socket p50 `16.5ms`.

New platform adapters can have the same costs.
HarmonyOS or other backends may use host tools, test runners, accessibility services, or bridge processes with this pattern:

- High startup costs.
- Low costs for repeated commands.
- A need for strict invalidation.

## Decision

When a backend has high startup costs and a reusable automation context, use persistent platform helper sessions.

A helper session is an optimization under daemon-owned lifetime policy.
It does not replace command correctness.
Platform modules own helper-manager mechanics.
A helper may retain processes, sockets, runner state, accessibility service flags, or device forwards for reuse.
Unless a separate cache contract defines explicit invalidation, the helper must execute each command against fresh platform state.

Use this session pattern:

1. On the first command that benefits from reuse, start the session lazily.
2. Bind the session to a device identity and helper/runner identity.
3. Communicate through a small validated protocol with request ids and version metadata.
4. While the identity and protocol remain valid, reuse the session.
5. When an invalidation condition occurs, invalidate the session.
6. If reuse fails, use the existing one-shot path for the current command, subject to the retry limits below.
7. Make shutdown best effort.
8. Make stale sessions disposable.

These conditions invalidate a session:

- Device disconnect.
- Helper reinstall or version change.
- Process exit.
- Socket or protocol failure.
- App or session identity change.
- Capture options that affect command semantics.

For Android snapshots, productize a persistent helper mode that retains `UiAutomation` and serves fresh snapshot requests over an `adb forward` socket.
Do not add snapshot result caching in this first step.
Infrastructure reuse provides the first reliable improvement.
The current implementation retains the existing one-shot instrumentation helper as the fallback for startup, socket, protocol, and request failures.
Both transports execute the same packaged helper contract.
If that helper is unavailable or invalid, agent-device must fail closed.
It must not substitute the legacy `adb uiautomator dump` snapshot engine.

Android permits only one reliable instrumentation-owned `UiAutomation` context per device.
Thus, snapshot capture, gesture viewport resolution, and planned-touch injection share one bundled automation helper (issue #1275; consistent with ADR 0013).
A live persistent helper session executes touch commands directly over its session socket.
Without a live persistent session, the same helper runs one-shot.
After a failed session command, one-shot retry applies only to idempotent reads, such as viewport resolution.
The failed session must stop before this retry.
Gesture injection is not idempotent because events may already be partially injected.
Thus, session gesture failures return directly without a one-shot retry.
Helper reuse must never let process ownership cause interference between commands.

For iOS, keep the XCTest runner session as the reference implementation for lifecycle and invalidation behavior.
Android does not need to copy iOS internals.
However, it should reuse these lifetime-policy concepts:

- Per-device session management.
- Readiness checks.
- Structured protocol errors.
- Fallback and invalidation.
- Request-scoped observability.

For future platforms such as HarmonyOS, prefer this helper-session contract when the native automation layer uses a runner-like model.
Avoid platform-specific startup assumptions in command handlers.

## Alternatives Considered

- **Keep only one-shot helpers.** This is the simplest robust option.
  Android measurements show approximately ten times slower steady-state snapshots without reuse.
- **Cache snapshots in the daemon.** This accelerates repeated reads.
  Without a mutation generation contract, it is unsafe after mutations, animations, navigation, system dialogs, or app process changes.
  Cache infrastructure can be added later.
  It should remain separate from helper-session reuse.
- **Create an abstract cross-platform runner immediately.** This is premature.
  iOS XCTest, Android instrumentation, macOS helper, Linux AT-SPI, and future HarmonyOS backends have different startup and transport mechanics.
  Share the daemon lifecycle contract first.
  Extract common code only where repetition appears.
- **Replace Android instrumentation with a normal app service.** This is potentially useful.
  However, Android `UiAutomation` access belongs to instrumentation.
  A persistent instrumentation process retains the required privilege model and removes repeated process startup.

## Consequences

Before persistent helper sessions become product features, they should be measured.
A prototype or benchmark should show meaningful wall-clock improvement on a realistic app state, not only a trivial screen.

Session managers need more lifecycle tests than one-shot helpers.
These tests cover:

- Startup.
- Ready protocol.
- Reuse.
- Timeout.
- Malformed response.
- Helper version mismatch.
- Device disconnect.
- Install invalidation.
- Shutdown.
- Exclusive instrumentation handoff.
- One-shot fallback.

Observability should report whether a command used, started, reused, or invalidated a persistent session, or used a one-shot fallback.
This information helps diagnose CI failures and user bug reports when a fast path fails.

Persistent sessions should not make direct interactive commands unexpectedly slow.
Use short connect/request timeouts for the persistent path.
Then use the existing one-shot timeout budget for the fallback.

The daemon remains the owner of helper lifetime policy.
Platform modules own helper-manager mechanics and may expose helper-session operations.
Request bindings and command handlers must not directly own or stop long-lived helper processes or raw host tool state.

This ADR does not require every backend to implement a persistent session.
It defines the preferred design when a backend has the startup and reuse costs demonstrated by iOS and Android snapshots.
