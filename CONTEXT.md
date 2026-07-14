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
- DaemonArtifactType: optional semantic category supplied by the command or adapter that owns a
  daemon-managed downloadable artifact, such as `screenshot`, `screen-recording`, or `trace-log`.
  Finalization and inventory code must preserve this value when present, not infer it from
  filenames, fields, or MIME types. Missing artifact types must not prevent artifact registration.
  The type documents known values while allowing provider or command owners to introduce more
  specific strings.
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
- Host process primitive: low-level host PID helpers in `src/utils/host-process.ts` for liveness,
  start-time/command reads, process listing, process-tree expansion, PID de-duplication, and
  best-effort signaling. It must not own domain cleanup policy such as browser ownership markers,
  runner lease reclamation, daemon takeover checks, or app-log PID metadata verification.
- Command surface: catalog of public command identity, interface exposure, adapter policy, and shared command metadata across CLI, Node.js, MCP, and batch entrypoints.
- Daemon command registry: daemon-side source of truth for command route ownership and request-policy traits, including admission exemptions, session locking, selector validation, replay-scoped actions, recording invalidation, Android dialog guards, and request provider device resolution.
- Runner command traits: per-command-type classification for iOS/macOS runner lifecycle behavior, distinct from the public command surface and daemon command registry. The Swift runner traits classify interaction, read-only, and runner-lifecycle axes for XCTest execution; Swift resolves the alert command as read-only only for its `get` action. The TypeScript runner command traits classify daemon-side runner send/recovery policy such as read-only retry routing, readiness probes, and recent-healthy-mutation preflight skips; the TypeScript table is command-type keyed and currently classifies alert as read-only for daemon retry policy. Each side keeps one source of truth keyed by runner command type.
- Coordinate-first resolved element activation: iOS/macOS runner interaction pattern where a selector or text query resolves the semantic `XCUIElement`, then activation uses the element's resolved center coordinate when a frame is available. This keeps target selection semantic while avoiding `XCUIElement.tap()` post-action element re-resolution after normal navigation. tvOS remains focus/remote-driven.
- Interaction dispatch path: one concrete route an interaction command takes to the device (runtime selector/ref resolution, direct iOS selector, native ref via web clickRef, coordinate, maestro non-hittable fallback). Every path classifies every guarantee in the ADR 0011 registry.
- Gesture plan: typed, platform-neutral normalization of one- or two-contact gesture intent into bounded pointer trajectories. Contact topology is separate from motion; two-contact intent remains pan/pinch/rotate/transform even when native injection shares one executor. See ADR 0013.
- Android planned-touch executor: Android-local adapter seam that accepts `AndroidTouchPlan`—the
  platform-neutral `GesturePlan` plus Android's stationary long-press plan—and selects the paired
  provider-native touch/viewport adapter or bundled instrumentation-helper adapter. Scroll and
  long-press retain their command semantics and only share physical touch execution through this
  seam. Helper long-press executes its absolute stationary path without a viewport probe; provider
  long-press receives its paired provider-owned viewport. See ADR 0013.
- Multi-touch geometry: the internal initial span and angle plus centroid translation, scale, and rotation used to build both contact trajectories. Geometry is viewport-aware and fails early when the requested motion cannot fit; it is not a public tuning surface.
- Maestro program: source-preserving typed representation of supported Maestro YAML. It is interpreted directly through the compatibility runtime port and never lowered through generic replay action strings. See ADR 0015.
- Maestro observation generation: explicit compatibility-engine state identifying evidence captured since the most recent mutation. Queries may share semantic evidence within one generation; every mutation attempt invalidates it before dispatch. Interaction geometry is action-local: unique exact iOS selectors resolve and tap atomically in XCTest, while coordinate dispatch uses a fresh target snapshot. Rectangles are never shared across command boundaries.
- Guarantee cell: one (dispatch path, guarantee) entry in `src/contracts/interaction-guarantees.ts`, classified as runtime/runner/delegated/inapplicable/waived. Completeness is a compile error; honesty is gate-tested.
- Owned waiver: a `gap:`-prefixed waived cell carrying a `trackingIssue` URL. Waivers are diffable debt with an owner, never folklore.
- Parity table: golden JSON fixture under `contracts/fixtures/` consumed by both vitest and the runner's gated Swift tests, so a cross-language rule (e.g. tap-point policy) cannot drift silently. Change the rule only via the table.
- Coverage manifest: `CONTRACT_COVERAGE` export beside each interaction contract test file claiming which matrix cells it proves; the coverage gate requires every enforced/delegated cell to be claimed and rejects overclaims of waived cells.
- Delegation-on-error: a fast path falling back to the runtime path on semantic failure shapes. It closes failure-side guarantee cells only — never success-path parity.
- Ref generation pin: optional `~s<n>` suffix on an @ref carrying the snapshot generation it was minted from. Accepted as input everywhere, emitted by no tree output (snapshot token budget), auto-appended by the MCP layer, stripped and ignored by replay.
- Ref frame (ADR 0014): the session's single authorization namespace for mutation `@ref`s, kept separate from the latest operational observation (`session.snapshot`). It owns a frozen epoch (the `refsGeneration` the client received), an immutable source tree, a lifecycle state (`active`/`expired`), and an issuance scope (`all` for a complete snapshot, or the bounded set of ref bodies a partial publication emitted). Owned solely by `src/daemon/ref-frame.ts`. A complete snapshot activates an `all` frame; `find`/settled diff/replay divergence activate a bounded partial frame that supersedes the prior one; internal read captures never activate or reindex it.
- Frame expiry seam (ADR 0014): every mutating leaf calls `expireRefFrame` synchronously, immediately before the device op that may change element identity (after all pre-action guards), so a post-dispatch failure still leaves the frame expired — there is no success-only rollback. Ref resolution binds `@eN` against the frame's source tree, so an Android freshness (or any read-only) capture cannot retarget an admitted ref by positional coincidence; a fresh capture's coordinates are adopted only when its node's local identity matches.
- Mutation admission (ADR 0014): a ref mutation is admitted only against an active frame whose epoch and issuance scope authorize the ref (`admitRefMutation`, order-sensitive reasons `ref_frame_expired` → `ref_generation_mismatch` → `plain_ref_requires_complete_frame` → `ref_not_issued`). Rejections carry `details.reason` and name the lifetime failure. A ref-oriented sequence that performs several mutations must re-observe (snapshot), consume an honestly issued settled ref in pinned form, or use selectors. Read-only ref consumers stay fail-open with a staleness warning while the frame retains the ref's evidence.
- Settled observation: opt-in (`--settle`) post-action payload on press/click/fill/longpress — the quiet-window stable loop re-captures until the UI settles, and the response carries the diff vs the pre-action tree (changed lines only, added lines with fresh refs, `refsGeneration` when the settled tree was stored). Best-effort: never fails the action; `settled: false` plus a hint on never-quiet content.
- Snapshot capture plan: per-strategy ordered chain of iOS snapshot capture backends (recursive tree, query sweep, private AX) run by one plan runner under a shared wall-clock budget; recovery ordering is declared data, never a per-call-site branch.
- Snapshot quality verdict: structured outcome (state, backend, reason code, effective depth, collapsed leaves) computed once by the plan runner and shipped with every planned snapshot payload; the daemon and CLI render it instead of re-deriving degradation from node shapes.
- AX-unavailable target invalidation: iOS/macOS runner behavior where a root accessibility snapshot failure such as `kAXErrorIllegalArgument` marks the cached `XCUIApplication` target handle suspect. The runner fails closed for degraded interactive snapshots, clears the cached target, and lets the next command reacquire the app through normal activation.
- Resolution disclosure (ADR 0012 decision 2): additive `resolution` field on press/click/fill/longpress responses discloses how the acting path resolved its target — `runtime`/`unique` or `runtime`/`disambiguated` (with `matchCount`/`winnerDiagnostic`/`tiebreak`/up-to-5 `alternatives`) on the daemon tree, `ref`/`exact` for a resolved `@ref` (runtime-ref and native-ref), `ref`/`label-fallback` when runtime-ref recovered a stale `@ref` via its recorded trailing label, or `direct-ios`/`not-observed` on the XCTest fast path; absent entirely on the coordinate path and on dispatches whose runner actually executed the maestro non-hittable coordinate fallback (permission alone keeps the direct path's `not-observed`). Pre-action diagnostics only: `winnerDiagnostic`/`alternatives` entries carry an opaque, non-`@` `diagnosticRef` that is never ref-issued, never MCP-pinned, and cannot be reused as an `@ref` target — a fresh snapshot/find is required before acting on an alternative.

## Architecture (perfect-shape refactor, completed 2026-07)

ADR 0011 (interaction guarantee contract) is the interaction-semantics counterpart of ADR 0008's
registry thesis: the dispatch-path × guarantee matrix is declared once in
`src/contracts/interaction-guarantees.ts`, completeness is type-enforced, honesty and coverage are
gate-enforced, and cross-language rules are pinned by golden parity tables. New dispatch paths and
guarantees are whole-matrix decisions, not local edits.

The perfect-shape refactor is complete and merged. Its end-state:

- Two derivation registries. One `CommandDescriptor` per command
  (`src/core/command-descriptor/registry.ts`) is the single declaration site from which the
  public/internal/local command catalog, capability matrix, daemon command registry, batch allowlist,
  timeout policy, MCP exposure list, capability-checked CLI command list, post-action observation
  traits, and platform dispatch command set are _derived_ by parity-tested projection. Command
  families still own surface metadata/CLI schema in `src/commands/**`, but descriptor/catalog
  coherence guards prevent surface names from drifting; system command facets now project their
  simple Node client command methods. Closed public Node-client result contracts are narrowed
  through `CommandResultMap`; action/backend-dependent methods remain explicitly broad until their
  public response projections are reconciled. See
  [Node client result types](docs/node-client-result-types.md). One
  `PlatformPlugin` per platform family (`src/core/platform-plugin/`) stops core/daemon from branching
  on platform, with the Apple plugin the first instance. See
  [ADR 0008](docs/adr/0008-command-descriptor-registry.md).
- Typed result spine. Per-command typed results replaced the ad-hoc `Record`-typed returns across
  the daemon/dispatch path; errors gained machine-readable `retriable`/`supportedOn` signals on
  `DaemonError` (#939). Error-system conventions live in
  [ADR 0010](docs/adr/0010-error-system.md).
- Apple platform model. Internally `Platform` is `apple` (plus `android`/`linux`/`web`) with an
  `appleOs` discriminant (`ios | ipados | tvos | watchos | visionos | macos`); the shared Apple
  engine lives under `src/platforms/apple/core/` with per-OS leaves under
  `src/platforms/apple/os/<os>/`. The public wire stays non-breaking: `PUBLIC_PLATFORMS`
  (`src/kernel/device.ts`) still emits `ios`/`macos` leaf output. See
  [ADR 0009](docs/adr/0009-apple-platform-consolidation.md).
- Folder DAG + layering lint. `scripts/layering/check.ts` enforces two different scopes in CI.
  GLOBALLY, across every production source file, it enforces the R1-R3 move rules
  (kernel-sink, commands-floor, platforms-seam) and rejects all production static value-import
  cycles. Separately, it ranks an explicit target spine — as rank groups, lowest (kernel sink) to
  highest, where `A ◄ B` means B may not be outranked by A (the back-edge order the gate rejects), NOT
  that every displayed import exists:
  `kernel ◄ { contracts, request, selectors, platforms } ◄ core ◄ { commands, cli-schema } ◄ { client, daemon-server } ◄ daemon-client ◄ cli` —
  and rejects every back-edge within it. Root entrypoints and peripheral zones (`mcp`, `compat`,
  `remote`, `metro`, `replay`, `recording`, `snapshot`, `screenshot-diff`, `cloud-webdriver`,
  `sdk`, `utils`) are deliberately unranked (`UNRANKED_ZONES` in `scripts/layering/model.ts`):
  they still obey R1-R4, but the gate asserts no total back-edge order over them. It is not a
  claim that every folder is arranged in one DAG. `model.test.ts` guards that no new zone escapes
  this classification silently.
- Agent-cost. Responses carry a cost block and MCP `outputSchema`, rendered through a leveled
  `ResponseView`.

### Deferred

The refactor is substantively done; these follow-ups are intentionally deferred, not lost:

- Dynamic Node-client results — interactions, observability, alert, React Native overlay, and
  settings remain broad until their action/backend-specific payloads have accurate public
  projections. See [Node client result types](docs/node-client-result-types.md).
- Legacy alias drops — ~175 LOC of legacy aliases/barrels remain, gated to the next major.

## Selector Capture Reliability Contract

Selector capture is allowed to optimize transport, helper reuse, and polling, but it must preserve
the observable freshness and failure semantics below before any runtime refactor.

- Direct iOS selector queries are a narrow fast path only: iOS, simple one-term
  `id`/`label`/`text`/`value` selectors, and never while `postGestureStabilization` is pending. A
  direct miss may fall back to the snapshot selector path, but ambiguous matches and runner errors
  must surface instead of silently falling back. `get text` uses direct native selectors only for
  simple `id` selectors because label/text/value reads need snapshot disambiguation.
- Regular selector reads remain capture-backed. `@ref`s resolve against the authorized ref frame's
  source tree (ADR 0014), not whatever now sits at that index in a newer observation; selector
  `get`/`is`/`find`/`wait` capture through the backend. `find` and `wait`
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
- Maestro target matching remains snapshot-based and policy-owned. Coordinate dispatch always uses a
  fresh target snapshot. A unique exact iOS match may instead reuse bound same-generation semantic
  evidence and dispatch through XCTest's atomic selector tap; structured live-selector failures return
  to fresh Maestro resolution. This optimization must not erase Maestro regex/string selector behavior,
  visibility filtering, provider-order first-match selection, explicit index selection, or
  assertion/wait semantics. Provider normalization belongs below the compatibility layer. Plain text is
  exact and regex-aware; do not add substring/fuzzy recovery, synthetic geometry, or hierarchy-shape
  heuristics that change authored selector meaning.

Evidence: [ADR 0002](docs/adr/0002-persistent-platform-helper-sessions.md),
[ADR 0004](docs/adr/0004-ios-snapshot-backend-strategy.md),
[ADR 0005](docs/adr/0005-ios-runner-interaction-lifecycle.md),
[Maestro compatibility debt map](docs/maestro-compat-debt-map.md),
[`find.test.ts`](src/daemon/handlers/__tests__/find.test.ts),
[`snapshot-handler.test.ts`](src/daemon/handlers/__tests__/snapshot-handler.test.ts),
[`snapshot-scoped-refs.test.ts`](src/daemon/handlers/__tests__/snapshot-scoped-refs.test.ts),
[`runtime-targets-typed.test.ts`](src/compat/maestro/__tests__/runtime-targets-typed.test.ts), and
[`android-test-suite.test.ts`](test/integration/provider-scenarios/android-test-suite.test.ts).

## Testing Principles

- Provider-backed integration scenarios should exercise the public daemon path whenever practical.
- Prefer the in-process provider scenario harness for broad scenarios; keep HTTP contract tests narrow and transport-specific.
- Provider seams sit below platform modules so integration tests still cover platform command translation.
- Provider transcripts are for exact external command contracts.
- Scenario transcripts are for broad, user-rooted workflows that should replace mocked handler unit tests.
- Unit tests stay for pure logic, parser matrices, selector matching, capabilities, and important edge cases.
