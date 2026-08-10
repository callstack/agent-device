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
- [Architecture](#architecture) — the command-descriptor baseline and staged platform-runtime seam
- [Selector capture reliability contract](#selector-capture-reliability-contract) — invariants any capture refactor must preserve
- [Testing principles](#testing-principles)

## Terms

### Sessions, targets, devices

- Interactor (legacy): monolithic semantic interface between dispatch and platform behavior, retained
  only for commands not yet migrated under ADR 0019. Avoid for new or migrated command behavior.
- Platform family: one internal ownership axis in the canonical registry (`apple`, `android`,
  `harmonyos`, `vega`, `linux`, or `web`). Family ownership does not imply uniform support across its
  leaves, device kinds, or providers.
- Platform leaf: concrete OS/device shape within a family whose support is classified independently,
  such as iOS simulator, physical iOS, tvOS, or macOS within Apple.
- Platform module: private `@agent-device/platform-*` package that owns one family's device mechanics
  behind a metadata-eager, implementation-lazy façade.
- Implementation laziness: platform-module property where family metadata is cheap to compose while
  discovery mechanics, runtime implementations, and helper managers load only when that family is
  first discovered or bound.
- Device inventory gateway: platform-neutral composition of canonical local-family and provider
  inventory sources. It discovers and classifies devices before any selected-device binding exists.
- Device runtime gateway: platform-neutral seam that reports runtime facts and binds one admitted
  device to its selected runtime owner.
- Runtime owner: exactly one local platform module or provider runtime selected to execute device
  behavior for an ownership-qualified device.
- Request binding: request-lived attachment of cancellation, diagnostics, progress, and admitted
  context to a runtime owner. It never owns a helper manager, healthy helper generation, or adopted
  durable resource.
- Bound device runtime: behavior-bearing view returned by a request binding after the required
  operations in a command's runtime use are proven.
- Runtime facet: capability-cohesive interface on a bound device runtime, with normalized semantic
  inputs and typed outcomes rather than command names or daemon payloads.
- Runtime fact: typed claim about behavior available for one exact platform leaf, device/backend, and
  provider mode.
- Narrowed bound runtime: compile-time projection exposing required facets non-optionally, explicitly
  preferred facets optionally, and no undeclared facets; handlers do not cast missing proof into
  existence.
- Host capability: narrow authority injected into a platform module for host process execution,
  diagnostics, progress, or resolved native assets; it carries no daemon request or session policy.
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
- Runtime use: platform-neutral declaration on a command descriptor containing operations required
  for admission and, separately, preferred fast paths whose absence does not reject the command.
- Inventory use: platform-neutral declaration for an inventory command that composes canonical local
  family and provider inventory sources without fabricating a selected-device binding.
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
- Version-skew invariant: a client replaces any local daemon whose version or code signature
  differs (`isReusableDaemonInfo`, both directions), so local client↔daemon skew cannot exist.
  Version-skew compat code is legitimate on exactly four axes and its comment must name one:
  the remote daemon boundary (the protocol version gates breaking changes only — older remote
  daemons silently ignore additive optional fields), separately versioned runner/helper binaries,
  persisted artifacts (`.ad`/config/env/session logs — handle or refuse with migration guidance,
  forever), and released API consumers. "Older local daemon" tolerance is dead code.

### Interaction, refs, and guarantees

- Interaction dispatch path: one concrete route an interaction command takes to the device (runtime
  selector/ref resolution, direct iOS selector, native ref via web clickRef, coordinate, maestro
  non-hittable fallback). Every path classifies every guarantee in the ADR 0011 registry.
- Coordinate-first resolved element activation: iOS/macOS runner interaction pattern where a selector
  or text query resolves the semantic `XCUIElement`, then activation uses the element's resolved
  center coordinate when a frame is available. This keeps target selection semantic while avoiding
  `XCUIElement.tap()` post-action element re-resolution after normal navigation. tvOS remains
  focus/remote-driven.
- Parent-owned touch point: runtime ref/selector activation keeps the resolved parent identity but,
  when its center belongs to an independently interactive descendant, moves the coordinate to the
  nearest region with bounded clearance from those child controls. The exact center remains the
  zero-cost default when no child competes; a fully tiled parent fails closed so a child must be named.
- Guarantee cell: one (dispatch path, guarantee) entry in `packages/contracts/src/interaction-guarantees.ts`,
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
- Deferred interaction outcome: the daemon's post-response answer to "did that mutation actually
  take effect" — pending interaction outcome retry, post-gesture stabilization, and Android
  snapshot freshness recovery. `src/daemon/deferred-interaction-outcome.ts` is its one interface:
  every mutating route marks through it after dispatch, and every snapshot capture resolves
  through it; the three `SessionState` fields stay with their R7 owners (the module itself owns
  `postGestureStabilization`, so the seam adds no node to the R9 cycle). Marking
  order is load-bearing (pending outcome retry before stabilization), each marker keeps its own
  eligibility gate, and the module owns only these post-action markers — never ADR 0014 ref-frame
  expiry or the ADR 0012/0016 staged protocols. Distinct from the same-response settled
  observation below.
- Settled observation: opt-in (`--settle`) post-action payload on press/click/fill/longpress and, on
  the generic route, scroll/back — the quiet-window stable loop re-captures until the UI settles, and
  the response carries the diff vs the pre-action tree (changed lines only, added lines with fresh
  refs, `refsGeneration` when the settled tree was stored). Best-effort: never fails the action;
  `settled: false` plus a hint on never-quiet content. Which commands support it is a descriptor
  trait (`postActionObservation`), and the CLI flags, MCP fields, timeout envelope, and ref-pinning
  all derive from it. The two routes differ in ONE way, deliberately: the touch commands diff against
  the freshly resolved pre-action capture, while scroll/back — which resolve nothing — diff against
  the session's stored pre-action tree, so their diff reads "settled tree vs the last tree you
  observed".
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
- Screen-recording facet: runtime facet that starts platform screen/video capture and returns a live
  handle plus its durable descriptor. It is distinct from script recording.
- Live resource handle: process-local authority to finish or forcibly dispose active app-log,
  screen-recording, or profiler work through outcome-bearing `finish`/`forceCleanup` operations; its
  `AsyncDisposable` adapter rejects when cleanup is unconfirmed. A neutral contract handle may live
  in R7-owned `SessionState`; it is never serialized into persisted recovery state.
- Durable resource descriptor: bounded, versioned, persistable identity and recovery state from
  which the same runtime owner can deterministically reattach, recover completion, or report a typed
  missing/unreattachable outcome.
- Reattachment: fenced recovery attempt by the descriptor's exact runtime owner, returning a live
  handle, completed result, missing state, or typed unreattachable reason without restarting the
  resource or falling through to another owner.
- Recording backend (legacy): daemon-selected tag-to-implementation interface retained only for
  screen-recording commands not yet migrated under ADR 0019. Avoid for new behavior.

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

- Provider: external device/runtime adapter that may own a complete device runtime or contribute a
  typed transport to a platform module; ownership is resolved and bound per request.
- Provider-backed integration scenario: device-free integration test that runs the real daemon
  request path and replaces only external device or host tool execution.
- Cloud WebDriver runtime: direct provider runtime owner that maps a cloud-owned Appium/WebDriver
  session into agent-device leases, inventory, runtime facts/facets, durable resources, and release
  without provider-specific daemon branches. Its exact facts differ from local Apple/Android
  runtimes because snapshots come from Appium page source.
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

## Architecture

ADR 0011 (interaction guarantee contract) is the interaction-semantics counterpart of ADR 0008's
registry thesis: the dispatch-path × guarantee matrix is declared once in
`packages/contracts/src/interaction-guarantees.ts`, completeness is type-enforced, honesty and coverage are
gate-enforced, and cross-language rules are pinned by golden parity tables. New dispatch paths and
guarantees are whole-matrix decisions, not local edits.

The 2026 command/registry refactor is the enforced baseline. ADR 0019 keeps the command-descriptor
axis and stages a deeper platform-runtime seam, one abandonment-safe command cutover at a time:

- Command and platform axes. One `CommandDescriptor` per command
  (`src/core/command-descriptor/registry.ts`) is the single declaration site from which the
  public/internal/local command catalog, capability matrix, daemon command registry, batch allowlist,
  timeout policy, MCP exposure list, capability-checked CLI command list, post-action observation
  traits, and platform dispatch command set are _derived_ by parity-tested projection. Command
  families still own surface metadata/CLI schema in `src/commands/**`, but descriptor/catalog
  coherence guards prevent surface names from drifting; system command facets now project their
  simple Node client command methods. Closed public Node-client result contracts are narrowed through
  `CommandResultMap`; action/backend-dependent methods remain explicitly broad until their public
  response projections are reconciled. See
  [Node client result types](docs/node-client-result-types.md). The current shallow `PlatformPlugin`
  registry remains the complete legacy adapter for unmigrated commands. ADR 0019 replaces that axis
  command by command with an immutable, metadata-eager/implementation-lazy platform-module registry:
  descriptors declare inventory or device runtime use, runtime owners report exact facts and
  behavior-bearing facets, and only the root composition module imports concrete packages. See
  [ADR 0008](docs/adr/0008-command-descriptor-registry.md) and
  [ADR 0019](docs/adr/0019-request-bound-platform-runtime.md).
- Typed result spine. Per-command typed results replaced the ad-hoc `Record`-typed returns across the
  daemon/dispatch path; errors gained machine-readable `retriable`/`supportedOn` signals on
  `DaemonError` (#939). Error-system conventions live in [ADR 0010](docs/adr/0010-error-system.md).
- Apple platform model. Internally `Platform` is `apple` (plus `android`/`harmonyos`/`vega`/`linux`/`web`) with an
  `appleOs` discriminant (`ios | ipados | tvos | watchos | visionos | macos`); the shared Apple engine
  lives under `src/platforms/apple/core/` with per-OS leaves under `src/platforms/apple/os/<os>/`.
  The public wire stays non-breaking: `PUBLIC_PLATFORMS` (`packages/kernel/src/device.ts`) still emits
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
  `{ contracts, request, selectors, platforms, utils, replay, recording, snapshot, screenshot-diff } ◄ core ◄ { commands, cli-schema, mcp } ◄ { client, daemon-server, compat, remote, metro, sdk } ◄ daemon-client ◄ cli` (the former rank-0 kernel zone lives in `packages/kernel` since #1490 W0, and shared selectors now live behind the private `@agent-device/selectors` package between `@agent-device/ad-script` and `@agent-device/ad-replay`; the former `cloud-webdriver` leaf lives behind the single `@agent-device/provider-webdriver` facade since W1b, Limrun lives behind the single `@agent-device/provider-limrun` facade since W1d, and the dependency-free XML codec lives behind the single `@agent-device/xml` facade; R11 package-boundaries owns these physical seams) —
  and rejects every back-edge within it. Only `(root)` is unranked among `src/` zones
  (`UNRANKED_ZONES` in `scripts/layering/model.ts`): it holds the entrypoints and the composition
  roots that wire the command surface into the daemon, and R2 forbids `daemon/` from importing
  `commands/`, so those files sit outside the spine by construction. Extracted workspace packages
  are classified separately and enforced by R11. The satellite zones used to be unranked too, on the
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
  and `set()` re-puts the same reference, so any `session.<field> = …` in the daemon is an immediate
  write to store-owned live state — visibility depends on aliasing, not on an API call, and the map
  is not rehydrated across daemon restart. That is
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
  obstacle to reading a subsystem in isolation: inside a strongly-connected component of 47 files,
  no file has a self-contained slice. `TYPE_CYCLE_BASELINE`, derived from the zone ceilings in
  `scripts/layering/daemon-modularity.ts`, ratchets it for **growth only**, deliberately unlike R6: reducing it
  is a real refactor rather than a file move, so a hard equality would turn every unrelated
  improvement into a baseline edit. A shrunk tree is reported in the success line instead of
  failing. Hubs by in-component dependents: `core/dispatch.ts` (8),
  `command-catalog.ts` (7), `commands/interaction/runtime/resolution.ts` (6),
  `core/command-descriptor/registry.ts` (6). The former type hubs (`runtime-contract.ts`,
  `commands/runtime-types.ts`, `backend.ts`, `commands/runtime-common.ts`) left the cycle when
  #1632 sank `backend.ts`'s two upward type imports — 27 files stranded out of the component at
  once.
- Daemon modularity ratchets (R10). The same tooling-only declaration pins R7's writer-owned
  field/owner-claim counts, R9's 47 members by zone (`commands` 14, `daemon-server` 17, `core` 10,
  `platforms` 2, root 3, `client` 1), and the external production importers of `daemon/types.ts`
  (down to 2: the client normalizers and remote artifacts). R7 counts and external importers may
  only shrink; no zone may grow inside R9, and replay/Maestro/replay-test engine files remain outside
  it. This per-zone ratchet is intentionally stricter than R9's ordinary total-growth rule: even
  moving cycle membership into a zone at its ceiling must be justified by lowering another ceiling
  or changing the baseline explicitly. The #1478 extraction arc (P0–P5) completed against these
  ratchets: engines live behind the `packages/{maestro,replay-test,ad-replay,selectors}` façades, engines
  cannot import daemon/platform/provider implementations, and no logical module may deep-import
  another module's `internal/` tree. The P6 platform-modularity phases were measured and deferred
  at the #1478 checkpoint (2026-08-04); HarmonyOS then supplied the additional real adapter pressure
  that earned ADR 0019's staged platform-runtime migration. Its substrate plus complete
  `devices`/`logs`/`network` checkpoint must validate the seam before any further command migration.
  These are ratchets, not permission to scaffold façades before a real seam has two adapters.
- Platform package boundary (R13). ADR 0019 has exactly six private
  `@agent-device/platform-*` package façades and one root composition file,
  `src/platform-runtime.ts`. R13 pins that total registration, forbids contracts-to-platform,
  sibling-platform, root/daemon, and raw-process edges in every import form (including tests), and
  keeps package façades metadata-eager but inventory/runtime mechanics lazy. Composition cannot probe tools, prepare
  assets, or construct helpers. Each rule has a planted-red structural case; R11 still owns the
  general workspace exports/dependency boundary.
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
- **Policy × detail boundaries on demonstrated axes of change.** The two demonstrated axes are
  `CommandDescriptor` inventory/runtime use (what the system needs) × inventory sources or
  runtime-owner facts/facets (how a family or exact device can do it), ADR 0008/0009/0019. The shallow
  `PlatformPlugin` remains only as the legacy command adapter during staged adoption.
  Boundary-crossing enforcement is narrower than the principle: the
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
- **Module seams** (the #1478 extraction's durable rules). State crosses seams as immutable
  values, authority crosses seams as capabilities, and both only narrow; a capability seam earns
  its port only when it has two real adapters, normally the daemon adapter and a deterministic
  adapter running the same contract suite. A pure shared kernel instead stays behind its direct
  package façade; the selector engine is the worked example. Calls go down through module façades
  and back through ports; no inter-module event bus — current diagnostics/session events, and the
  ADR 0018 journal if accepted, are observation channels rather than coordination mechanisms. No
  engine receives `DaemonRequest`, `DaemonError`, `SessionStore`, mutable `SessionState`, provider
  handles, or concrete platform implementations; the daemon adapter closes each capability over one
  already-admitted request, so an engine cannot express a session name, acquire a lock, or select a
  provider scope. Session state keeps three consistency
  disciplines distinct and never forces them through one generic transaction: immediate pessimistic
  transitions for ref/observation lineage (ADR 0014's mid-request expiry is why end-of-request
  commit/rollback is rejected), staged arm/complete/close-succeeded/commit-or-abort protocols with
  operation-keyed receipts for repair/publication (ADR 0012/0016), and append-only facts for
  recorded actions and diagnostics. Gates: R10 zero-count module policies, R11 package boundaries,
  the façade symbol pins, and R7 ownership.
- **Tests couple to stable interfaces.** Norm (see [Testing Principles](#testing-principles))
  backed by the test-only-DI-seam gate above; broader test-strength enforcement is planned, not
  present — tracked under [#1412](https://github.com/callstack/agent-device/issues/1412).
- **Component metrics are observatory data, never gates.** Instability/abstractness per zone is a
  proposal ([#1423](https://github.com/callstack/agent-device/issues/1423), building on #1410's
  graph model) to locate concrete, high-fan-in modules worth pinning harder — explicitly never a
  CI threshold.

### Deferred

The completed command/registry baseline retains these deferred follow-ups. ADR 0019's staged
platform-runtime migration is an active accepted decision, not part of this list:

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
- An `XCTEST_RECORDED_FAILURE` after an iOS tap is an ambiguous outcome, not proof that the tap missed.
  The daemon may take one same-presentation post-action capture against a usable retained snapshot;
  only a changed accessibility digest converts the result to success with a warning. Capture failure,
  sparse or mismatched presentation, and an unchanged digest remain failures so corroboration cannot
  turn an unknown tap into a false success.
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
[ADR 0015](docs/adr/0015-direct-maestro-engine.md),
[`find.test.ts`](src/daemon/handlers/__tests__/find.test.ts),
[`snapshot-handler.test.ts`](src/daemon/handlers/__tests__/snapshot-handler.test.ts),
[`snapshot-scoped-refs.test.ts`](src/daemon/handlers/__tests__/snapshot-scoped-refs.test.ts),
[`runtime-targets-typed.test.ts`](packages/maestro/src/internal/__tests__/runtime-targets-typed.test.ts), and
[`android-test-suite.test.ts`](test/integration/provider-scenarios/android-test-suite.test.ts).

## Testing Principles

- Provider-backed integration scenarios should exercise the public daemon path whenever practical.
- Prefer the in-process provider scenario harness for broad scenarios; keep HTTP contract tests narrow
  and transport-specific.
- Transport providers sit below a platform module; direct provider runtimes sit beside local family
  owners. Both run the same runtime contract scenarios through the public daemon path so provider
  coverage still exercises the appropriate device-command translation.
- Provider transcripts are for exact external command contracts.
- Scenario transcripts are for broad, user-rooted workflows that should replace mocked handler unit
  tests.
- Unit tests stay for pure logic, parser matrices, selector matching, capabilities, and important edge
  cases.

Gate selection, speed rules, and shared fixtures live in [docs/agents/testing.md](docs/agents/testing.md).
