# Agent Device Domain Context

Durable vocabulary for this repo. Use these names in code, tests, issue titles, and architecture
notes rather than coining parallel ones. You rarely need the whole file — jump to the section your
task touches:

- [Sessions, targets, devices](#sessions-targets-devices)
- [Command surface & routing](#command-surface--routing)
- [Interaction, refs, and guarantees](#interaction-refs-and-guarantees)
- [Gestures & touch](#gestures--touch)
- [Snapshots & capture](#snapshots--capture)
- [Recording & replay](#recording--replay)
- [Maestro compatibility](#maestro-compatibility)
- [Providers, cloud, and the test harness](#providers-cloud-and-the-test-harness)
- [Architecture](#architecture-perfect-shape-refactor-completed-2026-07) — the two-registry end state
- [Selector capture reliability contract](#selector-capture-reliability-contract) — invariants any capture refactor must preserve
- [Testing principles](#testing-principles)

## Terms

### Sessions, targets, devices

- Interactor: semantic interface between command dispatch and platform behavior.
- Platform module: platform-specific implementation behind the Interactor.
- Target: selected automation destination, such as mobile, tv, or desktop.
- Modality: broad supported device family, such as mobile, tv, or desktop.
- Session: daemon-owned state for a selected target and opened app or surface.
- Device lease: logical remote ownership of one selected device for a tenant/run/client and lease
  provider, separate from platform helper process locking.
- Device key: stable provider-scoped device identity used for lease contention, such as a simulator
  UDID, physical device id, or provider inventory id.
- Lease provider: remote connection source that routes and owns a device lease, such as `proxy`,
  cloud bridge, or `limrun`.
- Runner/process lease: backend helper mutual-exclusion guard for platform runners or tools; it is
  not the remote client ownership boundary.
- iOS physical-device control: Apple-local module selected from discovery evidence. CoreDevice
  devices retain the `devicectl` controller; devices found only by `xctrace` use the XCTest
  controller for readiness, app activation/termination, and cable-bound usbmux runner transport
  without claiming unsupported app inventory or installation capabilities.
- Host process primitive: low-level host PID helpers in `src/utils/host-process.ts` for liveness,
  start-time/command reads, process listing, process-tree expansion, PID de-duplication, and
  best-effort signaling. It must not own domain cleanup policy such as browser ownership markers,
  runner lease reclamation, daemon takeover checks, or app-log PID metadata verification.

### Command surface & routing

- Command surface: catalog of public command identity, interface exposure, adapter policy, and
  shared command metadata across CLI, Node.js, MCP, and batch entrypoints.
- Daemon command registry: daemon-side source of truth for command route ownership and
  request-policy traits, including admission exemptions, session locking, selector validation,
  replay-scoped actions, recording invalidation, Android dialog guards, and request provider device
  resolution.
- Runner command traits: per-command-type classification for iOS/macOS runner lifecycle behavior,
  distinct from the public command surface and daemon command registry. The Swift runner traits
  classify interaction, read-only, and runner-lifecycle axes for XCTest execution; Swift resolves the
  alert command as read-only only for its `get` action. The TypeScript runner command traits classify
  daemon-side runner send/recovery policy such as read-only retry routing, readiness probes, and
  recent-healthy-mutation preflight skips; the TypeScript table is command-type keyed and currently
  classifies alert as read-only for daemon retry policy. Each side keeps one source of truth keyed by
  runner command type.
- Daemon RPC protocol version: integer advertised by daemon/proxy `/health` and checked by remote
  clients before HTTP JSON-RPC; bump only for breaking transport/request/response compatibility
  across the remote daemon boundary.

### Interaction, refs, and guarantees

- Interaction dispatch path: one concrete route an interaction command takes to the device (runtime
  selector/ref resolution, direct iOS selector, native ref via web clickRef, coordinate, maestro
  non-hittable fallback). Every path classifies every guarantee in the ADR 0011 registry.
- Coordinate-first resolved element activation: iOS/macOS runner interaction pattern where a selector
  or text query resolves the semantic `XCUIElement`, then activation uses the element's resolved
  center coordinate when a frame is available. This keeps target selection semantic while avoiding
  `XCUIElement.tap()` post-action element re-resolution after normal navigation. tvOS remains
  focus/remote-driven.
- Guarantee cell: one (dispatch path, guarantee) entry in `src/contracts/interaction-guarantees.ts`,
  classified as runtime/runner/delegated/inapplicable/waived. Completeness is a compile error;
  honesty is gate-tested.
- Owned waiver: a `gap:`-prefixed waived cell carrying a `trackingIssue` URL. Waivers are diffable
  debt with an owner, never folklore.
- Delegation-on-error: a fast path falling back to the runtime path on semantic failure shapes. It
  closes failure-side guarantee cells only — never success-path parity.
- Parity table: golden JSON fixture under `contracts/fixtures/` consumed by both vitest and the
  runner's gated Swift tests, so a cross-language rule (e.g. tap-point policy) cannot drift silently.
  Change the rule only via the table.
- Coverage manifest: `CONTRACT_COVERAGE` export beside each interaction contract test file claiming
  which matrix cells it proves; the coverage gate requires every enforced/delegated cell to be
  claimed and rejects overclaims of waived cells.
- Ref frame (ADR 0014): the session's single authorization namespace for mutation `@ref`s, kept
  separate from the latest operational observation (`session.snapshot`). It owns a frozen epoch (the
  `refsGeneration` the client received), an immutable source tree, a lifecycle state
  (`active`/`expired`), and an issuance scope (`all` for a complete snapshot, or the bounded set of
  ref bodies a partial publication emitted). Owned solely by `src/daemon/ref-frame.ts`. A complete
  snapshot activates an `all` frame; `find`/settled diff/replay divergence activate a bounded partial
  frame that supersedes the prior one; internal read captures never activate or reindex it. Replay
  captures return opaque, one-shot lineage evidence, and daemon response composition activates refs
  synchronously only after the exact inline or successfully written overflow projection is known.
  Every finalization attempt consumes its evidence. The outer replay retains its stable session lock
  plus the device lock when known through finalization, so external commands cannot interleave;
  nested replay actions reuse that scope and invalidate lineage through capture, ref-frame,
  side-effect, or session-lifetime changes.
- Frame expiry seam (ADR 0014): every mutating leaf calls `expireRefFrame` synchronously, immediately
  before the device op that may change element identity (after all pre-action guards), so a
  post-dispatch failure still leaves the frame expired — there is no success-only rollback. Ref
  resolution binds `@eN` against the frame's source tree, so an Android freshness (or any read-only)
  capture cannot retarget an admitted ref by positional coincidence; a fresh capture's coordinates are
  adopted only when its node's local identity matches.
- Mutation admission (ADR 0014): a ref mutation is admitted only against an active frame whose epoch
  and issuance scope authorize the ref (`admitRefMutation`, order-sensitive reasons
  `ref_frame_expired` → `ref_generation_mismatch` → `plain_ref_requires_complete_frame` →
  `ref_not_issued`). Rejections carry `details.reason` and name the lifetime failure. A ref-oriented
  sequence that performs several mutations must re-observe (snapshot), consume an honestly issued
  settled ref in pinned form, or use selectors. Read-only ref consumers stay fail-open with a
  staleness warning while the frame retains the ref's evidence.
- Ref generation pin: optional `~s<n>` suffix on an @ref carrying the snapshot generation it was
  minted from. Accepted as input everywhere, emitted by no tree output (snapshot token budget),
  auto-appended by the MCP layer, stripped and ignored by replay.
- Settled observation: opt-in (`--settle`) post-action payload on press/click/fill/longpress — the
  quiet-window stable loop re-captures until the UI settles, and the response carries the diff vs the
  pre-action tree (changed lines only, added lines with fresh refs, `refsGeneration` when the settled
  tree was stored). Best-effort: never fails the action; `settled: false` plus a hint on never-quiet
  content.
- Resolution disclosure (ADR 0012 decision 2): additive `resolution` field on
  press/click/fill/longpress responses discloses how the acting path resolved its target —
  `runtime`/`unique` or `runtime`/`disambiguated` (with `matchCount`/`winnerDiagnostic`/`tiebreak`/
  up-to-5 `alternatives`) on the daemon tree, `ref`/`exact` for a resolved `@ref` (runtime-ref and
  native-ref), `ref`/`label-fallback` when runtime-ref recovered a stale `@ref` via its recorded
  trailing label, or `direct-ios`/`not-observed` on the XCTest fast path; absent entirely on the
  coordinate path and on dispatches whose runner actually executed the maestro non-hittable
  coordinate fallback (permission alone keeps the direct path's `not-observed`). Pre-action
  diagnostics only: `winnerDiagnostic`/`alternatives` entries carry an opaque, non-`@`
  `diagnosticRef` that is never ref-issued, never MCP-pinned, and cannot be reused as an `@ref`
  target — a fresh snapshot/find is required before acting on an alternative.

### Gestures & touch

- Gesture plan: typed, platform-neutral normalization of one- or two-contact gesture intent into
  bounded pointer trajectories. Contact topology is separate from motion; two-contact intent remains
  pan/pinch/rotate/transform even when native injection shares one executor. See ADR 0013.
- Android planned-touch executor: Android-local adapter seam that accepts `AndroidTouchPlan` — the
  platform-neutral `GesturePlan` plus Android's stationary long-press plan — and selects the paired
  provider-native touch/viewport adapter or bundled instrumentation-helper adapter. Scroll and
  long-press retain their command semantics and only share physical touch execution through this
  seam. Helper long-press executes its absolute stationary path without a viewport probe; provider
  long-press receives its paired provider-owned viewport. See ADR 0013.
- Multi-touch geometry: the internal initial span and angle plus centroid translation, scale, and
  rotation used to build both contact trajectories. Geometry is viewport-aware and fails early when
  the requested motion cannot fit; it is not a public tuning surface.

### Snapshots & capture

- Snapshot capture plan: per-strategy ordered chain of iOS snapshot capture backends (recursive tree,
  query sweep, private AX) run by one plan runner under a shared wall-clock budget; recovery ordering
  is declared data, never a per-call-site branch.
- Snapshot quality verdict: structured outcome (state, backend, reason code, effective depth,
  collapsed leaves) computed once by the plan runner and shipped with every planned snapshot payload;
  the daemon and CLI render it instead of re-deriving degradation from node shapes.
- iOS WebView semantic presentation: the interactive snapshot projection that recognizes XCTest's
  typed `WebView` root and WebKit's `Other -> StaticText` wrapper pairs. It keeps raw diagnostics
  unchanged, presents ordinary wrapper text as `StaticText`, and presents wrappers carrying WebKit's
  numeric HTML heading level as `Heading`.
- AX-unavailable target invalidation: iOS/macOS runner behavior where a root accessibility snapshot
  failure such as `kAXErrorIllegalArgument` marks the cached `XCUIApplication` target handle suspect.
  The runner fails closed for degraded interactive snapshots, clears the cached target, and lets the
  next command reacquire the app through normal activation.

### Recording & replay

- Script recording: opt-in session mode armed before actions so a persisted `.ad` can carry portable
  action inputs and recording-time target identity evidence. It is distinct from screen/video
  recording.
- Recorded input parameterization: explicit fill authoring contract that sends literal text only to
  the live interaction while the recorder stores `${VAR}` before any durable
  recording/event/publication boundary. The caller owns the uppercase variable name; no selector or
  field-name heuristic infers sensitivity. Replay resolves the placeholder immediately before dispatch
  and preserves the authored placeholder if that run is recorded again.
- Open-to-destination script: self-contained `.ad` script with exactly one initial `open`, a
  destination guard after its last app-state mutation, no `close`, and an app session left active for
  subsequent work. Avoid: replay (artifact noun), fragment (reserved for lifecycle-free composition),
  partial script.
- Destination guard: portable selector-targeted `wait` near the end of an open-to-destination script
  that confirms a landmark on the ready destination screen before replay hands the live session to
  its caller.
- Recording backend: daemon-internal module interface selected per recording target that owns
  platform recording validation, output path policy, start/stop execution, and record-only cleanup
  below the daemon recording lifecycle.

### Maestro compatibility

- Maestro program: source-preserving typed representation of supported Maestro YAML. It is
  interpreted directly through the compatibility runtime port and never lowered through generic
  replay action strings. See ADR 0015.
- Maestro observation generation: explicit compatibility-engine state identifying evidence captured
  since the most recent mutation. Queries may share semantic evidence within one generation; every
  mutation attempt invalidates it before dispatch. Interaction geometry is action-local: unique exact
  iOS selectors resolve and tap atomically in XCTest, while coordinate dispatch uses a fresh target
  snapshot. Rectangles are never shared across command boundaries.

### Providers, cloud, and the test harness

- Provider: request-scoped adapter interface for external device, runner, or host tool execution.
- Provider-backed integration scenario: device-free integration test that runs the real daemon
  request path and replaces only external device or host tool execution.
- Cloud WebDriver runtime: package-shaped `ProviderDeviceRuntime` implementation that maps a
  cloud-owned Appium/WebDriver session into agent-device lease, inventory, install, interactor, and
  release hooks without adding provider-specific branches to daemon routing. Cloud WebDriver adapters
  must expose explicit command capabilities because snapshots come from Appium page source rather
  than agent-device native iOS runner or Android helper backends.
- CloudArtifact: provider-hosted session output such as video, Appium logs, device logs, automation
  logs, or provider dashboard links. Cloud artifacts stay under the `cloudArtifacts` response field
  so they do not collide with daemon-managed local/downloadable `artifacts`.
- DaemonArtifactType: optional semantic category supplied by the command or adapter that owns a
  daemon-managed downloadable artifact, such as `screenshot`, `screen-recording`, or `trace-log`.
  Finalization and inventory code must preserve this value when present, not infer it from filenames,
  fields, or MIME types. Missing artifact types must not prevent artifact registration. The type
  documents known values while allowing provider or command owners to introduce more specific
  strings.
- Provider transcript: exact record of provider calls used when a test must verify platform command
  translation.
- Scenario transcript: command-level integration flow that describes user-visible behavior through
  daemon commands.
- In-process provider scenario harness: integration runner that invokes the daemon request handler
  directly without opening an HTTP listener.
- HTTP contract test: narrow test that verifies JSON-RPC transport, auth, and response finalization
  over the daemon HTTP boundary.

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
  simple Node client command methods. Closed public Node-client result contracts are narrowed through
  `CommandResultMap`; action/backend-dependent methods remain explicitly broad until their public
  response projections are reconciled. See
  [Node client result types](docs/node-client-result-types.md). One `PlatformPlugin` per platform
  family (`src/core/platform-plugin/`) stops core/daemon from branching on platform, with the Apple
  plugin the first instance. See [ADR 0008](docs/adr/0008-command-descriptor-registry.md).
- Typed result spine. Per-command typed results replaced the ad-hoc `Record`-typed returns across the
  daemon/dispatch path; errors gained machine-readable `retriable`/`supportedOn` signals on
  `DaemonError` (#939). Error-system conventions live in [ADR 0010](docs/adr/0010-error-system.md).
- Apple platform model. Internally `Platform` is `apple` (plus `android`/`vega`/`linux`/`web`) with an
  `appleOs` discriminant (`ios | ipados | tvos | watchos | visionos | macos`); the shared Apple engine
  lives under `src/platforms/apple/core/` with per-OS leaves under `src/platforms/apple/os/<os>/`.
  The public wire stays non-breaking: `PUBLIC_PLATFORMS` (`src/kernel/device.ts`) still emits
  `ios`/`macos` leaf output. See [ADR 0009](docs/adr/0009-apple-platform-consolidation.md).
- Vega platform model. Initial Vega OS support is deliberately **VVD-only**: discovery returns
  `VirtualDevice`, and platform capability admission rejects physical Fire TV devices until durable
  hardware evidence validates discovery, lifecycle, and the complete remote-control contract.
  Vega capture, selector, inventory, install, logging, and performance backends remain separate
  follow-up surfaces.
- Folder DAG + layering lint. `scripts/layering/check.ts` enforces five rules across four scopes in CI.
  GLOBALLY, across every production source file, it enforces the R1-R3 move rules (kernel-sink,
  commands-floor, platforms-seam) and rejects all production static value-import cycles. R1-R3 are
  declared as data in `scripts/layering/zone-policy.ts` (`ZONE_POLICIES`): which zones a boundary
  governs, which import kinds it tolerates, and which path prefixes are its declared seam. A fourth
  zone boundary is a table entry, not a fourth predicate. `zone-policy.test.ts` asserts each
  boundary fires and each exemption holds — necessary because the tree is clean, so a rule that
  stopped matching would look exactly like a rule being obeyed. Separately,
  it ranks an explicit target spine — as rank groups, lowest (kernel sink) to highest, where `A ◄ B`
  means B may not be outranked by A (the back-edge order the gate rejects), NOT that every displayed
  import exists:
  `kernel ◄ { contracts, request, selectors, platforms, utils, replay, recording, snapshot, screenshot-diff, cloud-webdriver } ◄ { core, providers } ◄ { commands, cli-schema, mcp } ◄ { client, daemon-server, compat, remote, metro, sdk } ◄ daemon-client ◄ cli` —
  and rejects every back-edge within it. Only `(root)` is unranked (`UNRANKED_ZONES` in
  `scripts/layering/model.ts`): it holds the entrypoints and the composition roots that wire the
  command surface into the daemon, and R2 forbids `daemon/` from importing `commands/`, so those
  files sit outside the spine by construction. The satellite zones used to be unranked too, on the
  grounds that ranking them would invent an order the architecture had not committed to; once
  `utils` joined the spine and `(root)` was emptied of shared contracts, every one of them turned
  out to have a consistent rank already. `model.test.ts` guards that no new zone escapes this
  classification silently. Thirdly, R6 ratchets the SAME inversion measured over TYPE-ONLY edges,
  which R5 ignores by design: a type-only import is free at runtime, but "zone A is declared in
  terms of zone B" is still a boundary claim, and ranking type edges surfaced 61 inversions the gate
  had never seen. `TYPE_INVERSION_BASELINE` in `check.ts` holds the remaining pairs with their
  counts; the numbers may only shrink, and a new pair fails outright. Down to **7**, and each is a
  deliberate position rather than a misplaced declaration: 4 are `AgentDeviceClient` used as an
  opaque handle (the facade is built from `commands/`'s own projection registry, so moving it down
  is a design call about where that registry belongs, not a file move), and 3 are the ADR 0003
  daemon descriptor, whose route type is `keyof typeof DAEMON_ROUTE_HANDLERS` — derived from what
  the server actually implements. Both are explained at the baseline.
- SessionState ownership (R7). `SessionStore.get()` returns the live record out of a private Map
  and `set()` re-puts the same reference, so any `session.<field> = …` in the daemon is a durable
  write to store-owned state — persistence depends on aliasing, not on an API call. That is
  workable while each field has an owner that keeps its invariants, so
  `SESSION_STATE_FIELD_OWNERS` (`scripts/layering/session-state.ts`) records them and the gate
  stops the set from growing quietly: a new field must declare an owner, a foreign write fails
  with the owner to call instead, and an owner that stops writing must be removed. The
  classification is **exhaustive** — every field is either in that table or in
  `STORE_OWNED_SESSION_STATE_FIELDS`, the positive claim "the store establishes this and nothing
  mutates it later". Without that parity a new field with no direct write would satisfy the gate by
  being invisible to it, and R7 would silently stop covering part of the type it covers. A direct
  write to a store-established field fails, naming both remedies. Detection follows session
  records through **aliased bindings** (`nextSession`, `provisionalSession`, `completedSession`),
  not just a local named `session`: matching the literal name is what let three genuine foreign
  writes sit unreported. Since there is no type information in the gate, the binding test is a name
  test paired with the declared-field filter — a provider or runner session only registers if it
  also writes a field `SessionState` owns, and the remedy is then the same. ADR 0014's ref frame
  and the snapshot lineage are the worked examples: the frame's four fields moved together across
  two modules until `activateRefFrame` took the transition, and `snapshotScopeSource` +
  `snapshotGeneration` were assigned in `snapshot-runtime.ts` until `setSnapshotLineage` took
  theirs.
- Type-cycle growth (R9). R4 keeps the VALUE import graph acyclic, so every remaining cycle is
  created by type-only imports — free at runtime, invisible to R5/R6, and the largest single
  obstacle to reading a subsystem in isolation: inside a strongly-connected component of 102 files,
  no file has a self-contained slice. `TYPE_CYCLE_BASELINE`, derived from the zone ceilings in
  `scripts/layering/daemon-modularity.ts`, ratchets it for **growth only**, deliberately unlike R6: reducing it
  is a real refactor rather than a file move, so a hard equality would turn every unrelated
  improvement into a baseline edit. A shrunk tree is reported in the success line instead of
  failing. Hubs by in-component dependents: `runtime-contract.ts` (25),
  `commands/runtime-types.ts` (21), `backend.ts` (15), `commands/runtime-common.ts` (12).
- Daemon modularity migration (R10). The same tooling-only declaration records R7 at 30
  writer-owned fields / 42 owner-file claims, R9's 102 members by zone (`commands` 33,
  `daemon-server` 30, `platforms` 19, `core` 12, root 5, `contracts` 2, `client` 1), and the four
  production importers of `daemon/types.ts` from outside daemon. R7 counts and external importers may
  only shrink; no zone may grow inside R9, and replay/Maestro/replay-test engine files remain outside
  it. This per-zone migration ratchet is intentionally stricter than R9's ordinary total-growth
  rule: during the extraction, even moving cycle membership into a zone at its ceiling must be
  justified by lowering another ceiling or changing the migration baseline explicitly. Zero-count
  policies begin enforcing when `src/ad-replay/` or `src/maestro/` first exists and
  already protect `src/replay/test/`: engines cannot import daemon/platform/provider implementations,
  and no logical module may deep-import another module's `internal/` tree. These are migration
  ratchets, not permission to scaffold façades before a real seam has two adapters.
- Zero-dep CI jobs (R8). Some jobs run scripts straight from a checkout with `install-deps: false`,
  so they have no `node_modules`. Nothing local can feel that constraint — every dev machine has
  `node_modules` sitting right there — so a script grows a package import, passes locally, and fails
  the runner on the resolve. R8 reads the zero-dep job list out of `.github/workflows/` (declaring a
  job zero-dep is what puts it under the rule; there is no second list to update), walks each job's
  entry scripts and their whole relative-import closure, and requires every specifier to be a Node
  builtin or another repo file. A zero-dep job whose entry scripts the scan cannot identify fails
  too, so the rule cannot be escaped by changing how the job invokes them. Specifiers come from
  `oxc-parser`'s module record rather than a line scan, because these closures include `--test`
  files whose fixtures legitimately contain import syntax inside strings.
- Agent-cost. Responses carry a cost block and MCP `outputSchema`, rendered through a leveled
  `ResponseView`.

### Principles and their gates

The architecture rules this repo runs on are Clean-Architecture-shaped. Some are fully
gate-enforced, some carry an open ledger that only shrinks, and some are norms with local evidence
but no gate yet — each bullet below says which. When judging a design change, argue from the rule;
when landing it, satisfy the gate where one exists.

- **Dependency Rule** (source dependencies point toward policy; details depend on abstractions).
  Gate: layering R1–R3 import direction plus the ranked spine's no-back-edges check
  (`scripts/layering/check.ts`). #1405's "shared contracts below their consumers" is dependency
  inversion stated as a merge gate. Ledger: `TYPE_INVERSION_BASELINE` — type-only inversions where
  types still flow the wrong way; the ratchet only tightens, and the long-term target is zero.
- **Acyclic components.** Gate: R4 bans value-import cycles globally. Type-only and dynamic-import
  cycles are deliberately tolerated by the gate; a report surfacing them as data is proposed in
  #1410 (the analysis half of the graph tooling, kept after the #1409 viewer was rejected) and is
  not landed yet.
- **Policy × detail boundaries on demonstrated axes of change.** The two registries are the two
  demonstrated axes: `CommandDescriptor` (what the system does) × `PlatformPlugin` (how a device
  does it), ADR 0008/0009. Boundary-crossing enforcement is narrower than the principle: the
  apple-platform leak guard (`publicPlatformString`, provider-integration suite) gates one specific
  DTO class — internal `apple` never reaching serialized public output — and the injectable Apple
  runner transport (`runnerProvider`, #1389) is one adopted seam, not a rule covering every
  boundary. Wider DTO/seam coverage is direction, not current enforcement.
- **Information hiding.** Gate: R7 — every `SessionState` field is classified and every write must
  occur inside its declared owner. Encapsulation of the one shared mutable object, enforced
  per-field. This covers `SessionState`; other shared state has no equivalent gate today.
- **Boundaries are earned, not speculative.** Norm with local evidence, not a gate: the platform
  descriptor layer (~600 LOC of boundary nobody needed) was deleted, and the depgraph viewer
  (#1409) was closed unmerged. A new abstraction layer needs a demonstrated second consumer or
  axis of change. The one gated slice of this norm is tests: CI forbids test-only DI seams — a
  missing seam gets added as a real one or not at all.
- **Tests couple to stable interfaces.** Norm (see [Testing Principles](#testing-principles))
  backed by the test-only-DI-seam gate above; broader test-strength enforcement is planned, not
  present — tracked under [#1412](https://github.com/callstack/agent-device/issues/1412).
- **Component metrics are observatory data, never gates.** Instability/abstractness per zone is a
  proposal ([#1423](https://github.com/callstack/agent-device/issues/1423), building on #1410's
  graph model) to locate concrete, high-fan-in modules worth pinning harder — explicitly never a
  CI threshold.

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
  `get`/`is`/`find`/`wait` capture through the backend. `find` and `wait` polling must bypass the
  750 ms snapshot cache. The cache is also bypassed while Android freshness recovery or post-gesture
  stabilization is active.
- Sparse snapshot quality verdicts are observable failures. Sparse captures must not replace
  `session.snapshot`, and selector routes should report the sparse verdict instead of treating a
  root-only or sparse tree as an empty UI.
- iOS sparse and AX failures are not proof of empty UI. Regular visible snapshots can recover through
  the capture plan; raw and strict paths preserve failure. `runnerFatal` invalidates the cached target
  and must never refresh healthy mutation recency.
- Android helper reuse must not become snapshot result caching. Freshness is short lived, marked only
  after navigation-sensitive actions, compared against broad route-safe baselines, and not learned
  from scoped, depth-limited, interactive, or ref-refresh snapshots.
- Pending interaction outcome retry runs before post-gesture stabilization. Android freshness then
  composes when needed. Stabilization applies after swipe, scroll, gesture, or an explicit flag, and
  disables direct iOS selector shortcuts while pending.
- `setSessionSnapshot` is the centralized session snapshot mutation path. Sparse captures do not write
  back, and empty `@ref`-scoped snapshot output must not replace the stored session snapshot.
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
- Prefer the in-process provider scenario harness for broad scenarios; keep HTTP contract tests narrow
  and transport-specific.
- Provider seams sit below platform modules so integration tests still cover platform command
  translation.
- Provider transcripts are for exact external command contracts.
- Scenario transcripts are for broad, user-rooted workflows that should replace mocked handler unit
  tests.
- Unit tests stay for pure logic, parser matrices, selector matching, capabilities, and important edge
  cases.

Gate selection, speed rules, and shared fixtures live in [docs/agents/testing.md](docs/agents/testing.md).
