# ADR 0002: Persistent Platform Helper Sessions

## Status

Accepted

## Context

Some platform automation backends are expensive to start but cheap to reuse. iOS already uses a
long-lived XCTest runner session with an HTTP transport. That model avoids paying `xcodebuild`,
runner boot, and XCTest readiness costs for every command, while still allowing the daemon to
invalidate the runner when the device, app, bundle, or runner process changes.

Android snapshot capture initially used a one-shot instrumentation helper. Every snapshot launched
`adb shell am instrument`, connected `UiAutomation`, captured the tree, emitted XML, and exited.
Recent Android snapshot optimizations reduced XML size, idle waiting, extra file I/O, and hidden
content hint work, but a throwaway prototype still showed that process/session startup dominates
steady-state latency:

- launcher snapshot: one-shot p50 `227ms`, persistent socket p50 `5.8ms`
- React Navigation playground snapshot: one-shot p50 `265.7ms`, persistent socket p50 `16.5ms`

The same pressure can appear on new platform adapters. HarmonyOS or other device backends may have
host tools, test runners, accessibility services, or bridge processes with the same shape: expensive
startup, cheap repeated commands, and a need for strict invalidation.

## Decision

Use persistent platform helper sessions when a backend has high startup cost and a reusable
automation context.

A helper session is an optimization layer owned by the daemon, not a replacement for command
correctness. It may keep processes, sockets, runner state, accessibility service flags, or device
forwards warm. It must still execute each command against fresh platform state unless a separate
cache contract has explicit invalidation.

The session pattern is:

- start lazily on the first command that benefits from reuse
- bind the session to a device identity and helper/runner identity
- communicate through a small validated protocol with request ids and version metadata
- reuse the session while the identity and protocol remain valid
- invalidate on device disconnect, helper reinstall/version change, process exit, socket/protocol
  failure, app/session identity change, or capture options that affect command semantics
- fall back to the existing one-shot path for the current command when reuse fails
- make shutdown best effort and make stale sessions disposable

For Android snapshots, productize a persistent helper mode that keeps `UiAutomation` alive and
serves fresh snapshot requests over an `adb forward` socket. Do not add snapshot result caching as
part of that first step. The first reliable win is infrastructure reuse, not data reuse. The current
implementation keeps the existing one-shot instrumentation helper as the fallback for startup,
socket, protocol, and request failures. Both transports execute the same packaged helper contract;
agent-device must fail closed when that helper is unavailable or invalid instead of substituting
the legacy `adb uiautomator dump` snapshot engine.

Android permits only one reliable instrumentation-owned `UiAutomation` context per device. Snapshot
capture, gesture viewport resolution, and planned-touch injection therefore share one bundled
automation helper: a live persistent helper session executes touch commands directly over its
session socket, and without one the same helper runs one-shot (amended 2026-07, issue #1275,
consistent with ADR 0013; previously touch synthesis shipped as a separate instrumentation helper,
so the daemon had to stop the persistent snapshot session before every gesture and let the next
snapshot restart it lazily). One-shot retry after a failed session command applies only to
idempotent reads such as viewport resolution, and only after the failed session has been stopped.
Gesture injection is not idempotent — events may already be partially injected — so a session
gesture failure surfaces directly instead of retrying one-shot. Helper reuse must never turn
process ownership into cross-command interference.

For iOS, keep the XCTest runner session as the reference implementation for lifecycle and
invalidation behavior. Android does not need to copy iOS internals, but it should reuse the same
daemon-side ideas: per-device session manager, readiness checks, structured protocol errors,
fallback/invalidation, and request-scoped observability.

For future platforms such as HarmonyOS, prefer designing adapters around this same helper-session
contract when their native automation layer is runner-like. Avoid embedding platform-specific
startup assumptions directly in command handlers.

## Alternatives Considered

- Keep one-shot helpers only: simplest and robust, but Android measurements show it leaves an order
  of magnitude of steady-state snapshot performance on the table.
- Cache snapshots in the daemon: faster for repeated reads, but unsafe after mutations, animations,
  navigation, system dialogs, or app process changes unless a mutation generation contract exists.
  Cache infrastructure can be added later; it should not be mixed with helper-session reuse.
- Promote an abstract cross-platform runner immediately: tempting, but premature. iOS XCTest,
  Android instrumentation, macOS helper, Linux AT-SPI, and future HarmonyOS backends have different
  startup and transport mechanics. Share the daemon lifecycle contract first, then extract common
  code only where repetition appears.
- Replace Android instrumentation with a normal app service: potentially useful, but Android
  `UiAutomation` access is instrumentation-owned. A persistent instrumentation process keeps the
  required privilege model while removing repeated process startup.

## Consequences

Persistent helper sessions should be measured before being productized. A prototype or benchmark
should show meaningful wall-clock improvement on a realistic app state, not just a trivial screen.

Session managers need more lifecycle tests than one-shot helpers: startup, ready protocol, reuse,
timeout, malformed response, helper version mismatch, device disconnect, install invalidation,
shutdown, exclusive instrumentation handoff, and one-shot fallback.

Observability should report whether a command used a persistent session, started one, reused one,
invalidated one, or fell back to one-shot. This keeps CI and user bug reports diagnosable when a
fast path fails.

Persistent sessions should not make direct interactive commands unexpectedly slow. Use short
connect/request timeouts for the persistent path, then fall back to the existing one-shot timeout
budget.

The daemon remains the owner of session lifecycle. Platform modules may expose helper-session
operations, but command handlers should not directly manage long-lived helper processes or raw host
tool state.

This ADR does not require every backend to implement a persistent session. It defines the preferred
shape when the backend has the same startup/reuse economics that iOS and Android snapshots now
demonstrate.
