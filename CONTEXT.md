# Agent Device Domain Context

## Terms

- Provider-backed integration scenario: device-free integration test that runs the real daemon request path and replaces only external device or host tool execution.
- Provider: request-scoped adapter interface for external device, runner, or host tool execution.
- Provider transcript: exact record of provider calls used when a test must verify platform command translation.
- Scenario transcript: command-level integration flow that describes user-visible behavior through daemon commands.
- In-process provider scenario harness: integration runner that invokes the daemon request handler directly without opening an HTTP listener.
- HTTP contract test: narrow test that verifies JSON-RPC transport, auth, and response finalization over the daemon HTTP boundary.
- Daemon RPC protocol version: integer advertised by daemon/proxy `/health` and checked by remote clients before HTTP JSON-RPC; bump only for breaking transport/request/response compatibility across the remote daemon boundary.
- Interactor: semantic interface between command dispatch and platform behavior.
- Platform module: platform-specific implementation behind the Interactor.
- Target: selected automation destination, such as mobile, tv, or desktop.
- Modality: broad supported device family, such as mobile, tv, or desktop.
- Session: daemon-owned state for a selected target and opened app or surface.
- Command surface: catalog of public command identity, interface exposure, adapter policy, and shared command metadata across CLI, Node.js, MCP, and batch entrypoints.
- Daemon command registry: daemon-side source of truth for command route ownership and request-policy traits, including admission exemptions, session locking, selector validation, replay-scoped actions, recording invalidation, Android dialog guards, and request provider device resolution.
- Runner command traits: per-command-type classification for iOS/macOS runner lifecycle behavior, distinct from the public command surface and daemon command registry. The Swift runner traits classify interaction, read-only, and runner-lifecycle axes for XCTest execution; Swift resolves the alert command as read-only only for its `get` action. The TypeScript runner command traits classify daemon-side runner send/recovery policy such as read-only retry routing, readiness probes, and recent-healthy-mutation preflight skips; the TypeScript table is command-type keyed and currently classifies alert as read-only for daemon retry policy. Each side keeps one source of truth keyed by runner command type.
- Coordinate-first resolved element activation: iOS/macOS runner interaction pattern where a selector or text query resolves the semantic `XCUIElement`, then activation uses the element's resolved center coordinate when a frame is available. This keeps target selection semantic while avoiding `XCUIElement.tap()` post-action element re-resolution after normal navigation. tvOS remains focus/remote-driven.
- Snapshot capture plan: per-strategy ordered chain of iOS snapshot capture backends (recursive tree, query sweep, private AX) run by one plan runner under a shared wall-clock budget; recovery ordering is declared data, never a per-call-site branch.
- Snapshot quality verdict: structured outcome (state, backend, reason code, effective depth, collapsed leaves) computed once by the plan runner and shipped with every planned snapshot payload; the daemon and CLI render it instead of re-deriving degradation from node shapes.
- AX-unavailable target invalidation: iOS/macOS runner behavior where a root accessibility snapshot failure such as `kAXErrorIllegalArgument` marks the cached `XCUIApplication` target handle suspect. The runner fails closed for degraded interactive snapshots, clears the cached target, and lets the next command reacquire the app through normal activation.

## Testing Principles

- Provider-backed integration scenarios should exercise the public daemon path whenever practical.
- Prefer the in-process provider scenario harness for broad scenarios; keep HTTP contract tests narrow and transport-specific.
- Provider seams sit below platform modules so integration tests still cover platform command translation.
- Provider transcripts are for exact external command contracts.
- Scenario transcripts are for broad, user-rooted workflows that should replace mocked handler unit tests.
- Unit tests stay for pure logic, parser matrices, selector matching, capabilities, and important edge cases.
