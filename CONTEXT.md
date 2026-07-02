# Agent Device Domain Context

## Terms

- Provider-backed integration scenario: device-free integration test that runs the real daemon request path and replaces only external device or host tool execution.
- Provider: request-scoped adapter interface for external device, runner, or host tool execution.
- Cloud WebDriver runtime: package-shaped `ProviderDeviceRuntime` implementation that maps a
  cloud-owned Appium/WebDriver session into agent-device lease, inventory, install, interactor, and
  release hooks without adding provider-specific branches to daemon routing. Cloud WebDriver
  adapters must expose explicit command capabilities because snapshots come from Appium page source
  rather than agent-device native iOS runner or Android helper backends.
- CloudArtifact: provider-hosted session output such as video, Appium logs, device logs, automation
  logs, or provider dashboard links. Cloud artifacts stay under the `cloudArtifacts` response field
  so they do not collide with daemon-managed local/downloadable `artifacts`.
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
- Recording backend: daemon-internal module interface selected per recording target that owns platform recording validation, output path policy, start/stop execution, and record-only cleanup below the daemon recording lifecycle.
- Device lease: logical remote ownership of one selected device for a
  tenant/run/client and lease provider, separate from platform helper process
  locking.
- Device key: stable provider-scoped device identity used for lease contention,
  such as a simulator UDID, physical device id, or provider inventory id.
- Lease provider: remote connection source that routes and owns a device lease,
  such as `proxy`, cloud bridge, or `limrun`.
- Runner/process lease: backend helper mutual-exclusion guard for platform
  runners or tools; it is not the remote client ownership boundary.
- Command surface: catalog of public command identity, interface exposure, adapter policy, and shared command metadata across CLI, Node.js, MCP, and batch entrypoints.
- Daemon command registry: daemon-side source of truth for command route ownership and request-policy traits, including admission exemptions, session locking, selector validation, replay-scoped actions, recording invalidation, Android dialog guards, and request provider device resolution.
- Runner command traits: per-command-type classification for iOS/macOS runner lifecycle behavior, distinct from the public command surface and daemon command registry. The Swift runner traits classify interaction, read-only, and runner-lifecycle axes for XCTest execution; Swift resolves the alert command as read-only only for its `get` action. The TypeScript runner command traits classify daemon-side runner send/recovery policy such as read-only retry routing, readiness probes, and recent-healthy-mutation preflight skips; the TypeScript table is command-type keyed and currently classifies alert as read-only for daemon retry policy. Each side keeps one source of truth keyed by runner command type.
- Coordinate-first resolved element activation: iOS/macOS runner interaction pattern where a selector or text query resolves the semantic `XCUIElement`, then activation uses the element's resolved center coordinate when a frame is available. This keeps target selection semantic while avoiding `XCUIElement.tap()` post-action element re-resolution after normal navigation. tvOS remains focus/remote-driven.
- Snapshot capture plan: per-strategy ordered chain of iOS snapshot capture backends (recursive tree, query sweep, private AX) run by one plan runner under a shared wall-clock budget; recovery ordering is declared data, never a per-call-site branch.
- Snapshot quality verdict: structured outcome (state, backend, reason code, effective depth, collapsed leaves) computed once by the plan runner and shipped with every planned snapshot payload; the daemon and CLI render it instead of re-deriving degradation from node shapes.
- AX-unavailable target invalidation: iOS/macOS runner behavior where a root accessibility snapshot failure such as `kAXErrorIllegalArgument` marks the cached `XCUIApplication` target handle suspect. The runner fails closed for degraded interactive snapshots, clears the cached target, and lets the next command reacquire the app through normal activation.

## Architecture (perfect-shape refactor, completed 2026-07)

The perfect-shape refactor is complete and merged. Its end-state:

- Two derivation registries. One `CommandDescriptor` per command
  (`src/core/command-descriptor/registry.ts`) is the single declaration site from which the public
  catalog, capability matrix, daemon command registry, batch allowlist, MCP tools, CLI schema, and
  the Node client surface are *derived* by parity-tested projection; the dispatch `switch` became a
  total map keyed on the command-name union (a missing handler is a compile error). One
  `PlatformPlugin` per platform family (`src/core/platform-plugin/`) stops core/daemon from branching
  on platform, with the Apple plugin the first instance. See
  [ADR 0008](docs/adr/0008-command-descriptor-registry.md).
- Typed result spine. Per-command typed results and a `TypedError` replaced the ad-hoc
  `Record`-typed returns across the daemon/dispatch path.
- Apple platform model. Internally `Platform` is `apple` (plus `android`/`linux`/`web`) with an
  `appleOs` discriminant (`ios | ipados | tvos | watchos | visionos | macos`); the shared Apple
  engine lives under `src/platforms/apple/core/` with per-OS leaves under
  `src/platforms/apple/os/<os>/`. The public wire stays non-breaking: `PUBLIC_PLATFORMS`
  (`src/kernel/device.ts`) still emits `ios`/`macos` leaf output. See
  [ADR 0009](docs/adr/0009-apple-platform-consolidation.md).
- Folder DAG + layering lint. `kernel`/`remote`/`metro`/`client`/`snapshot`/`screenshot-diff`/
  `replay`/`cli-parser`/`daemon-client`+`server`/`sdk` are arranged as an import-direction DAG
  (imports point down toward the kernel sink), enforced in CI by `scripts/layering/check.ts`.
- Agent-cost. Responses carry a cost block and MCP `outputSchema`, rendered through a leveled
  `ResponseView`.

### Deferred / next-minor

The refactor is substantively done; these follow-ups are intentionally deferred, not lost:

- Phase 2c — narrow the ~15 remaining `Record`-typed client methods in
  `src/client/client-types.ts` to their existing typed contracts (a semver-relevant public-API
  narrowing; not yet done).
- b.3 perf sampling body — all four `PlatformPlugin` daemon facets now route through the plugin
  (`appLog`, the `perf` support gate, `recording`, and `providers`; the last two via #1007). Only
  the `perf` sampling body (`buildPerfResponseData`) still branches in the daemon.
- Strict DAG back-edge inversion — the layering lint enforces the achievable subset; the full
  zero-back-edge DAG (e.g. `commands` → `cli`/`client`) is not done.
- Legacy alias drops — ~175 LOC of legacy aliases/barrels remain, gated to the next major.

## Selector Capture Reliability Contract

Selector capture is allowed to optimize transport, helper reuse, and polling, but it must preserve
the observable freshness and failure semantics below before any runtime refactor.

- Direct iOS selector queries are a narrow fast path only: iOS, simple one-term
  `id`/`label`/`text`/`value` selectors, and never while `postGestureStabilization` is pending. A
  direct miss may fall back to the snapshot selector path, but ambiguous matches and runner errors
  must surface instead of silently falling back. `get text` uses direct native selectors only for
  simple `id` selectors because label/text/value reads need snapshot disambiguation.
- Regular selector reads remain capture-backed. `@ref` reads resolve against stored session
  snapshots; selector `get`/`is`/`find`/`wait` capture through the backend. `find` and `wait`
  polling must bypass the 750 ms snapshot cache. The cache is also bypassed while Android freshness
  recovery or post-gesture stabilization is active.
- Sparse snapshot quality verdicts are observable failures. Sparse captures must not replace
  `session.snapshot`, and selector routes should report the sparse verdict instead of treating a
  root-only or sparse tree as an empty UI.
- iOS sparse and AX failures are not proof of empty UI. Regular visible snapshots can recover
  through the capture plan; raw and strict paths preserve failure. `runnerFatal` invalidates the
  cached target and must never refresh healthy mutation recency.
- Android helper reuse must not become snapshot result caching. Freshness is short lived, marked
  only after navigation-sensitive actions, compared against broad route-safe baselines, and not
  learned from scoped, depth-limited, interactive, or ref-refresh snapshots.
- Pending interaction outcome retry runs before post-gesture stabilization. Android freshness then
  composes when needed. Stabilization applies after swipe, scroll, gesture, or an explicit flag, and
  disables direct iOS selector shortcuts while pending.
- `setSessionSnapshot` is the centralized session snapshot mutation path. Sparse captures do not
  write back, and empty `@ref`-scoped snapshot output must not replace the stored session snapshot.
- Maestro target matching remains snapshot-based, fresh, and policy-rich. Native selector
  simplification must not erase Maestro regex/string selector behavior, visibility filtering,
  ranking, fuzzy fallback, visible-context preference, Android duplicate handling, tab-strip
  inference, or assertion/wait semantics.

Evidence: [ADR 0002](docs/adr/0002-persistent-platform-helper-sessions.md),
[ADR 0004](docs/adr/0004-ios-snapshot-backend-strategy.md),
[ADR 0005](docs/adr/0005-ios-runner-interaction-lifecycle.md),
[Maestro compatibility debt map](docs/maestro-compat-debt-map.md),
[`find.test.ts`](src/daemon/handlers/__tests__/find.test.ts),
[`snapshot-handler.test.ts`](src/daemon/handlers/__tests__/snapshot-handler.test.ts),
[`snapshot-scoped-refs.test.ts`](src/daemon/handlers/__tests__/snapshot-scoped-refs.test.ts),
[`runtime-targets.test.ts`](src/compat/maestro/__tests__/runtime-targets.test.ts), and
[`android-test-suite.test.ts`](test/integration/provider-scenarios/android-test-suite.test.ts).

## Testing Principles

- Provider-backed integration scenarios should exercise the public daemon path whenever practical.
- Prefer the in-process provider scenario harness for broad scenarios; keep HTTP contract tests narrow and transport-specific.
- Provider seams sit below platform modules so integration tests still cover platform command translation.
- Provider transcripts are for exact external command contracts.
- Scenario transcripts are for broad, user-rooted workflows that should replace mocked handler unit tests.
- Unit tests stay for pure logic, parser matrices, selector matching, capabilities, and important edge cases.
