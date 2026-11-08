# ADR 0019: Request-bound platform runtime

## Status

Accepted. Staged adoption completed on 2026-08-27.
The screen-recording amendment in ADR 0024 remains proposed.

## Rules at a glance

- Each family owns one private platform package; composition uses cheap metadata and lazy gateways.
- Package direction is `kernel < contracts < host-kit < capture-kit < provision-kit < platform/provider/daemon`.
- `RequestExecutionScope.bindDevice(device, use)` checks owner facts and exposes only declared operations.
- Provider ownership is exact and fail-closed; an owning provider never falls back to local behavior.
- Request bindings do not own helpers; durable handles may transfer to session ownership and recover through the exact owner.
- Each descriptor declares one `platformExecution` shape; facts govern device-command admission and handlers bind once.
- Startup recovery loads families with persisted evidence; composition supplies neutral host services and claim recovery.

## Context

A shallow platform plugin stopped the spread of platform conditionals, but left the daemon mapping platform tags and predicates to concrete behavior.
Six canonical families and their distinct leaves, backends, and provider modes need behavior-bearing runtimes without moving command policy into platforms.
The decision preserves daemon request policy, provider-first scenarios, Apple leaf models, helper performance, interaction guarantees, reference-frame expiry, normalized errors, package direction, and lazy startup.

## Decision

### 1. Platform modules provide behavior through one composition seam

Each canonical family has one private platform package with cheap metadata and lazy inventory and runtime gateways.
The family owns its mechanics, native tools, helper protocols, facts, parsers, recovery, and family tests.
It owns no daemon orchestration, command policy, or cross-family defaults.
Root composition constructs immutable inventory and provider-first runtime registries.
The request-provider resolver and wrapper order belong to its private lazy composition seam.
The daemon imports neutral contracts, not concrete platform implementations.
R13 governs concrete package imports and named consumer facets, including static, dynamic, type-only, and re-export edges.
R65 enforces daemon independence.
Only root composition and R13-named consumer seams statically import platform package roots; R65 counts the Apple runner package as a concrete platform dependency.
Gates pin substrate export subpaths, keep mechanics out of contracts, and reject the retired root platforms path.
Families may import contracts, domain packages, and explicitly injected host capabilities.
They may not import daemon requests or responses, mutable session state, command catalogs or grammar, root implementations, sibling platforms, or raw process primitives outside the shared host-command port.
Contracts contain neutral vocabulary, plans, and pure classification, not process supervision, live handles, recovery helpers, runtime codecs, capture parsers, host mechanics, or concrete implementation types.

The package direction is `kernel < contracts < host-kit < capture-kit < provision-kit < platform/provider/daemon`.
Host-kit exposes narrow host capability ports, not a generic utilities barrel.
Kernel owns pure primitives, including helpers that touch no process, file, or environment.
Capture-kit owns shared capture, snapshot, and recording mechanics, not generic platform code.
Provision-kit owns device and app preparation and may not import platform packages.
Capture-kit may not import provision-kit.
Each family owns its platform-specific parsers.
Shared logic moves to a domain package only after more than one implementation needs it.
There is no platform-common package, universal command dispatcher, or generic platform-resource union.

Android exposes named mechanics and host-port facets; only its named composition adapter binds the host port.
Apple exposes named domain facets and its runner through the Apple runner package.
The runner uses one focused injected host port, constructed by one composition root.
It owns its cache and sockets, imports no platform, root, or daemon code, and does not use raw process primitives.
The named runner operations facet remains an ownership seam, not a temporary exception.
A new family adds a named mechanics facet only with an owning consumer and evidence.
Kernel owns canonical family, Apple leaf, public-leaf, and selector identity.
Shared physical mechanics move behind a neutral injected substrate or after the last legacy consumer.

The registry is metadata-eager and implementation-lazy.
Discovery loads mechanics only for selected families; binding loads only the selected owner.
Helper managers are created on first use.
A family load does not load an unrelated implementation graph.
Composition may capture inert configured paths, but filesystem and tool probes, asset preparation, helper construction, and owner-specific fact probes stay lazy.
Structural evidence must prove the loading shape; a startup threshold alone is insufficient.

### 2. Runtime use joins facts and narrows the bound runtime

A command descriptor declares typed required operations and may separately declare preferred optimizations and fact-conditional semantic operations.
Input-selected use comes from a discriminated execution plan that retains literal types.
The three sets are pairwise disjoint.
Correctness never requires a preferred operation.
An owner that advertises a conditional operation must provide it, because its semantically complete path depends on that observation.
When unavailable, parity evidence must prove a complete required path.

Inventory use is separate: the inventory gateway selects family and provider sources without a synthetic device or a device binding.
Coverage includes all six family sources, every provider source, and selector and public-device projection parity.
A source classifies canonical family and required leaf identity before producing an ordinary device.

Each owner reports exhaustive facts for the exact leaf, device kind/backend, and provider mode.
Facets accept neutral semantic inputs and typed outcomes, not command names, daemon requests or responses, session state, CLI flags, or opaque command payloads.
Unsupported behavior is a missing facet and typed unavailability fact, not a throwing stub after binding.
Operation keys identify semantic operations; selecting one exposes no undeclared sibling.
The facts map is a mapped type over operation names, so a per-shape key cannot satisfy any runtime-use shape.
An operation modifier is not another operation and has no fact cell.
The owning leaf mechanic refuses an unsupported shape with a typed reason and hint when requested.
A missing member for an admitted whole operation is an ownership bug and fails closed.
An operation over unevenly supported subjects may report a fact per subject and an `unlisted` refusal; admission checks the requested subject before binding.
A request shape still belongs to the leaf mechanic.

`RequestExecutionScope.bindDevice(device, use)` resolves the exact owner, checks required facts, classifies preferred and conditional facts, creates or reuses the ownership-qualified request binding, and verifies every required and advertised implementation.
A missing advertised implementation is a runtime-contract error.
The returned projection exposes required operations as non-optional and declared preferred and conditional operations as optional and present only when available.
Undeclared operations are inaccessible, and the broad cached runtime stays private.
The descriptor and handler share a non-widened declaration; assertions and optional admission cannot manufacture required proof.
The runtime-facet-narrowing gate and compile-time contract tests enforce this boundary.

A preferred path may change optimization or path disclosure, not semantic executability.
Fallback to the complete required path needs a typed reason and explicit descriptor/ADR 0011 path classification, not a generic catch.
Helper reuse internal to a required operation is not a daemon-visible preferred operation.
Conditional operations instead require owner-cell parity; an advertised but missing operation fails as a contract error.
The handler must not silently use a path known to lose the observation.

The registry owns each family exactly once.
Support coverage is separate and must preserve legacy supported and unsupported cells and hints unless a separate decision changes behavior.
Apple coverage includes iOS simulator and physical differences, iPadOS, tvOS focus-only/no-coordinate behavior, macOS, visionOS deferred or supported cells, and the watchOS unsupported/discovery-absence sentinel.
Each fixture matches one family; a generic Apple fixture does not prove leaf coverage.

### 3. Provider ownership is exact and fail-closed

Exactly one owning provider binds its runtime. If no provider owns the device, the local family binds it. Multiple owners fail with an ownership-contract error.
Only providers declaring device-runtime ownership participate.
Narrow transport, tool, app-log, and recording providers are dependencies of the selected runtime, not additional owners.
An owning provider may implement facets or inject transport into a family runtime.
Missing required behavior returns typed unsupported and never falls back to local behavior.

Each binding exposes a unique restart-stable owner reference for the local family or configured provider instance.
Composition rejects duplicate references.
A durable descriptor records that reference.
Exact-owner binding resolves it directly and validates device and fence identity without repeating ownership arbitration.
An unavailable provider returns `unreattachable: owner-unavailable`, never a local binding.

### 4. Bindings attach to process-lived helper managers; they do not own helpers

Gateways and helper managers live for the process lifetime.
Helpers remain lazy, identity-bound, invalidatable, restartable, and idle-stoppable under ADR 0002.
A request binding attaches cancellation, diagnostics, progress, and admitted device/session context inside the active request diagnostics/event context; disposal releases only request attachments and acquisitions.
The disposable binding stays private to the request scope; handlers receive a non-disposable narrowed projection.
A bind rolls back partial acquisitions before rejection and publishes only after they all succeed.
Publication transfers ownership once to a reverse-order scope disposal stack; cached projections do not register it again.
The scope disposes on success, failure, cancellation, and early return before request-finished events, diagnostics flush, response construction, and lock release.
When operation and cleanup both fail, the operation error stays primary and cleanup is structured secondary evidence; cleanup-only failure surfaces normally.
Source-executed TypeScript does not use `await using` while the supported Node 22 runtime cannot parse it and lacks `AsyncDisposableStack`.

A binding is never adopted beyond the request.
Only a durable facet handle may transfer to session ownership.
It may retain its own helper attachment beyond the request; adoption detaches the original request's diagnostics, event, progress, and async context.
Finish or forced disposal uses the current request or explicit session-teardown observability scope.
Helpers stop only through explicit device lifecycle policy, invalidation, idle policy, or platform shutdown after session resources finalize.
Every helper-backed runtime has a lifecycle scenario proving that binding disposal never terminates or restarts a healthy helper and an immediate later binding reuses that generation.
Lifecycle scenarios also prove at-most-once shutdown of each still-owned generation, survival of adopted resources, and rollback after each partial acquisition.
Evidence must suit the helper; wall-clock behavior alone is insufficient.

### 5. Durable resources are reattachable by the same owner

> **Proposed amendment (ADR 0024, 2026-09-14), `screen-recording` only.**
> Screen recording would use stop-and-collect, with identity proof renewed at signal time.
> It would retain the manifest, destructive-step fences, and completed replay.
> Backend `stop(target, budget)` and `collect` would replace `reattach` and `cleanup`.
> This kind would remove cleanup-pending and the admission ledger, record recorder observation and native-path disposition beside the committed export, and archive each fence generation until both settle.
> For each durable kind, failed finish would no longer imply forced cleanup once its failed-finish test states retry requirements.
> App-log, audio-probe, and perf-capture would retain the recovery contracts unchanged.
> ADR 0024 owns the rationale, matrix, and tests. This proposal takes effect only when accepted.

Durable work uses a process-local live handle and a bounded, versioned descriptor for recovery by the exact runtime owner.
Destructive operations hold the ownership lease across fence validation, the native side effect, and the persisted transition, or use a token atomically enforced by the native or provider operation.
A preflight check alone is insufficient.
Session state may hold only a neutral facet-specific handle; persisted recovery holds the descriptor and neutral metadata.
The capture-kit durable-capture coordinator, which the daemon composes, owns persistence, adoption, compensation, fencing, and exact-owner recovery.
The daemon owns the app-log admission ledger and session-teardown ordering.
Events and the proposed journal are observability, not recovery authority.
The [durable resource recovery contracts](../../packages/capture-kit/docs/durable-resource-recovery.md) own the lifecycle, cleanup, and recovery details.

### 6. Command execution has one closed shape

Each descriptor's `platformExecution` facet explicitly declares exactly one internal execution shape: `none`, `host`, `inventory`, or `device-runtime`.
There is no default or legacy shape.
Public projections exclude it.
A `none` command has no platform adapter, capability admission, runtime use, or inventory use.
A `host` command uses one neutral typed domain service for host diagnostics, daemon-owner resource cleanup, or managed host tooling.
These services stay separate and form no generic host service.
It binds no device as its own shape; any device work uses another command's declared use.
The ADR 0008 route table owns handlers and request-policy traits.
R66 prevents capability buckets, legacy admission, and manufactured runtime proof.
R65 prevents daemon dependencies on concrete platform implementations.

Each mutable session resource has one R7 transition owner.
Session state excludes request bindings, concrete platform/provider types, and raw process or transport mechanics.
A change to resource state proves partial-start cleanup, transfer, finish, forced disposal, and error precedence.
Platform packages get no migration allowlist or root back-import exception.
Review each package or registry change and each command unit from a clean committed tree with all production files in HEAD; a layering pass with untracked production files is not evidence.
R9 cycle and R10 writer/owner ceilings may not grow; a change that shrinks a count lowers its ceiling in the same change without unused allowance.
For a platform-package change, affected checks select platform contract, provider, and coverage scenarios.

### 7. Adoption checkpoint

The completed checkpoint procedure and results remain in Git history.

### 8. Evidence tiers and admission

Facts are the only support authority for device commands.
A request-scoped device unit proves its typed declaration, facts, operations, and parity cells.
A durable-resource unit also proves the lifecycle requirements in sections 4 and 5.
These tiers remain review vocabulary, not a migration ledger.

### 9. Binding ergonomics: one bind per handler

Facts inspection is side-effect-free and answers admission, capabilities, and doctor without a binding, helper acquisition, or device access.
A handler binds exactly once with the execution use selected by its plan; it does not bind merely to read facts.
Changing an already migrated handler to facts inspection is a separate unit with independent review and parity evidence.
A post-action observation (`--settle`) may admit and bind one additional capture-only plan per request when the action use has no capture.
It inspects facts before binding.
If the action already requires capture, observation projects the cached binding.
A second bind with a mutating operation is the execution use the plan should have selected.

Use declarations share one neutral `defineUse`, without per-domain currying wrappers.
Required-only is the default.
A preferred operation requires recorded fast-path measurements.
A conditional operation requires parity evidence for both owner cells that depend on it and cells with a complete required path.
Speed alone belongs under preferred; universal correctness belongs under required.

### 10. Process-lifetime and cross-cutting surfaces

A cross-cutting facet has one owner and accompanies its first consuming command unit and review.
A separate facet PR without a consuming command is prohibited.
A parallel contract for the same concern is a seam violation.
Daemon startup gains no per-platform entrypoints.
Startup recovery is triggered only by persisted durable manifests or platform-owned markers; only families with evidence load.
Daemon shutdown first detaches helper managers for handoff, then stops each still-owned generation at most once after session resources finalize.
Each domain owns its isolated session-teardown step; there is no generic lifecycle-hook API.
Test-IME restoration is durable device state with marker recovery; helper stops follow platform policy; close-time cleanup uses neutral owner services.
Android test-IME marker and web browser orphan startup recovery still need to move to the evidence-triggered pattern when their owning domains migrate.

### 11. The platform-services port carries host asks that bind no device

The required `DaemonPlatformServices` port carries neutral host readiness, observations, and open-target questions across the daemon boundary.
Root composition supplies it; a daemon without composition cannot start.
All members are required, with no throwing placeholders.
Tests pass the same shared fixture instead of a platform-module mock behind the port.
The port uses neutral contract types and exposes no raw selector, gesture, runner call, or platform type.
Device execution remains on the request binding and owner facts remain the admission authority.
The claim-recovery gateway is also supplied by composition; the daemon owns the dead owner's state directory, reconstruction order, and disposal time.

## Relationship to prior decisions and consequences

ADR 0001 keeps provider-first scenarios and semantic provider operations; command migration supersedes the monolithic interactor and callback stack.
ADR 0002 keeps persistent protocols, invalidation, and explicitly safe one-shot fallback; platform managers own helpers, not request bindings.
ADRs 0007 and 0008 keep daemon-owned request policy, lease admission, lock order, and the descriptor registry; binding follows admission.
ADR 0009 keeps the Apple family and leaf axis; this decision supersedes its shallow plugin.
ADR 0010 keeps normalized errors and gains operation/cleanup precedence and typed reattachment outcomes.
ADRs 0011, 0013, and 0014 keep separate interaction paths and normalized gesture plans; daemon authorization expires immediately before any possibly mutating facet call, and observational facets cannot hide mutation.
Proposed ADR 0018 is not a dependency; its journal and teardown scopes may support observability, never coordination or persisted recovery state.

The daemon retains policy, command semantics, responses, session and lease ownership, selector and ref authority, interaction guarantees, and artifact orchestration.
Platforms own native mechanics, provider transport composition, helpers, and recovery.
New platforms implement contracts and facts instead of daemon tags and branches.
The staged migration cost temporary coexistence; closed execution shapes and structural policies remain.

## Alternatives considered

- Move platform source first: physical ownership would precede behavioral proof and prevent command-atomic review.
- Extend the plugin with tags: the daemon would still map tags to behavior.
- One interactor, universal dispatcher, or system facet: a broad optional interface hides leaf differences and restores unsupported stubs.
- Provider/local or old/new fallback: it hides ownership and semantic differences. ADR 0002 still permits explicitly safe internal helper fallbacks.
- Use events or a journal as the durable store: correctness would depend on observability.
- Add a separate process-local handle ledger: live session state already owns handles; a parallel store duplicates ownership. The bounded admission ledger contains no handles or descriptors and does not replace the manifest.
- Root re-export shims, a broad barrel, or ambient filesystem/process access: less movement, but it violates package closure, no-shim, named facets, host injection, and laziness.
- Rely only on performance thresholds: they can pass despite unrelated implementation loads; structural tests also prove loading shape.

## End state (proposed 2026-09-02, maintainer decision pending)

These targets are proposed defaults, not accepted commitments or authorization for work.
The proposed daemon top-level footprint is at most 60; its [measured baseline](../evidence/daemon-footprint-baseline-2026-09-02.md) is evidence, not a commitment.
The baseline counted top-level files of the old root daemon directory; since the daemon moved into layer folders in `@agent-device/daemon`, the target needs a new counting rule before it binds.
`@agent-device/daemon` remains a permanent R65 zone; the target concerns its contents, not directory retirement.
**Entry-to-platform hop count.** [ADR 0023](0023-end-state-hop-trace.md) defines the hop count; the [2026-09-03 hop trace evidence](../evidence/entry-to-platform-hop-trace-2026-09-03.md) holds the measured counts and links the ordered chains at pinned commit `0e7df74a1a`.
Composition and family runtime-loading boundaries count as hops, and package direction and named facets constrain any collapse.
The earlier target of 14 hops is superseded and is not reachable without a separate decision on cross-cutting request-scope wrappers.
Neither target has an owning issue, gate, or accepted budget; neither is a ratchet.
Command-surface, protocol-projection, and daemon-owned zones remain in the root.
Root platform host files need classification before a migration target is set; host-port adapters and composition modules have distinct roles.
The React Native package owns development tooling; CLI output and SDK normalization remain application adapters.
