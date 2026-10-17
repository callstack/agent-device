# ADR 0019: Request-Bound Platform Runtime

## Status

Completed (2026-08-27). Accepted for staged adoption on 2026-08-09.
The adoption checkpoint on 2026-08-10 succeeded, and broader-migration governance was added on 2026-08-11.
The historical evidence in sections 7–10 explains how the transition stayed shippable.
It no longer authorizes or schedules migration work.
Git history retains the completed process history.

The amendment of 2026-08-26 closed the Wave 6 residue.
It extends `host` beyond diagnostics to host-scoped platform work through a narrow, neutral, typed service.
Host diagnostics, daemon-owner resource cleanup, and managed host tooling share this execution category because none binds a request-scoped device runtime.
Their domain services remain separate and do not form a generic host grab bag.

An amendment proposed on 2026-09-23 accompanies the web press-shape refusal.
It states in section 3 that a modifier on an admitted operation is not a second operation and therefore has no fact cell.
A per-shape refusal on the owning leaf mechanic rests on that statement.
Without that statement, the next contributor can reasonably reach for a per-shape fact key.
The operation-facts mapped type cannot express such a key.

[ADR 0024](./0024-screen-recording-provable-signal.md) proposes an amendment dated 2026-09-14 for the `screen-recording` kind only.
The note at the start of section 5 describes it. It takes effect when ADR 0024 is accepted.

Completion through #2070–#2072 removes capability buckets and the legacy execution shape.
Every descriptor declares `none`, `host`, `inventory`, or `device-runtime`.
R65 enforces zero concrete platform dependencies from production `packages/daemon/src/**`.
R66 enforces facts-only admission and runtime proof without historical route or handler names.
Section 6 required deletion of the completed cutover table.

The #2082 extraction puts all six families' implementations and family-owned tests behind private package exports.
The `src/platforms` path and former R3 folder seam are retired.
R13 governs the import direction of concrete platform packages and implementation laziness.
The `retired-platforms-zone` gate rejects the old root path.

## Rules at a glance

- Daemon device-execution code depends on platform-neutral contracts.
  Private `@agent-device/platform-*` packages own mechanics and family-specific tests for the six canonical families.
  Root `src/__tests__/` owns shared install-source tests.
  The root composition module and R13-governed named consumer facades are the only production static value-import sites.
- The registry is **metadata-eager and implementation-lazy**.
  Cheap family identity, inventory entrypoints, and static fact declarations may load at composition time.
  Mechanics and process-lived helper managers load only when discovery or the first binding for that family needs them.
- Each canonical family has one local runtime owner.
  Support claims and tests cover the exact platform leaf, device kind/backend, and provider mode.
  Family ownership does not imply equal support for every leaf.
- Command descriptors declare one typed execution shape: inventory use or platform-neutral required device operations.
  A device-operation declaration declares any preferred optimizations and fact-conditional semantic operations separately.
  Runtime owners report device-specific facts and expose behavior through facets.
  Platform and provider implementations never name commands.
- `RequestExecutionScope.bindDevice(device, use)` resolves provider ownership, validates facts and concrete facets, and returns a runtime narrowed to proven use.
  Handlers cannot use undeclared facets. Casts and non-null assertions cannot repair absent proof.
- Provider ownership is authoritative and fail-closed.
  An owning provider may supply transport to a platform runtime or implement facets directly.
  Missing required behavior never causes a local-owner fallback.
- Process-lived helper managers, request-lived bindings, and daemon-session durable resources have separate lifetimes.
  Helpers remain lazy, identity-bound, invalidatable, and idle-stoppable.
  Disposal of a request binding never stops a healthy helper or adopted resource.
- Durable work has a process-local live handle and a versioned, persistable descriptor for recovery by the same owner.
  Under R7, live session state may own a neutral facet handle.
  Persisted recovery state contains only the descriptor and neutral metadata.
  Concrete platform process objects never cross the seam.
- Each descriptor explicitly declares exactly one shape: `none`, `host`, `inventory`, or `device-runtime`.
  `none` declares no platform execution.
  `host` declares host-scoped platform work through a neutral typed domain service for diagnostics, owner cleanup, or managed tooling.
  It binds no device runtime as its own shape.
  Any device-runtime part uses another command's declared use.
- Evidence is tiered by what a unit imports.
  Request-scoped device units prove facts, operations, and parity cells.
  Only durable-resource units require the lifecycle evidence in sections 4–5.
- A handler binds once with its execution use, subject to the section 9 observation exception.
  Admission, `capabilities`, and doctor use facts inspection without side effects.
  Required-only declarations are the default.
  Preferred operations require recorded measurements. A conditional operation requires parity evidence that explains why correctness depends on the owner fact.
- A cross-cutting facet accompanies its first consuming command unit.
  Daemon startup recovery is gated by evidence. Shutdown has two phases: detach, then stop.
  Each domain owns its session-teardown steps. There is no generic lifecycle-hook API.

## Context

ADR 0009 deliberately introduced a shallow `PlatformPlugin` around existing platform branches.
It preserved lazy imports byte-for-byte and moved each daemon column only after a parity gate proved equivalence.
That was the correct migration shape. It stopped the spread of platform conditionals.
However, its app-log, recording, performance, and provider facets still return tags or predicates that the daemon maps to concrete implementations.

The registry has six canonical families:

- `apple`
- `android`
- `harmonyos`
- `vega`
- `linux`
- `web`

HarmonyOS supplied the additional real adapter pressure that the earlier platform-package checkpoint deliberately deferred.
With this many families, a tag-to-implementation map leaves the daemon responsible for every platform variation, even with the conditional behind a plugin.

The replacement must preserve these architectural properties:

- Daemon-owned request policy.
- Provider-first integration scenarios.
- Apple-family leaf models.
- Kept-hot helper performance.
- Accurate interaction guarantees.
- Ref-frame expiry before mutation.
- Normalized errors.
- Package direction.
- Lazy CLI cold starts.

## Decision

### 1. Platform modules provide behavior through one composition seam

Each canonical family has one private `packages/platform-<family>` workspace package named `@agent-device/platform-<family>`.
Its façade exposes cheap metadata and lazy implementations of `DeviceInventorySource` and `DeviceRuntimeGateway`.
These implementations own platform tool calls, helper protocols, runtime facts, output parsers, recovery mechanics, and other native details.
A platform package contains only its family's implementations and mechanics.
It contains no daemon orchestration, command policy, or cross-family defaults.

The root composition module, `src/platform-runtime.ts`, constructs immutable inventory/runtime registries.
It injects a composed inventory gateway and provider-first runtime gateway into daemon request execution.
Its private `src/platform-runtime/request-providers.ts` submodule owns the cross-family resolver table for request providers and the wrapper order.
Only the canonical root may load this submodule.
It remains lazy until a request enters a provider scope.
Daemon device-execution modules import only the canonical root interface or runtime contracts.

`@agent-device/contracts` owns shared runtime interfaces and neutral data types.
In production, only these sites may statically import concrete platform package roots:

- The composition module.
- Its one private implementation submodule governed by R13.
- The consumer seams under `src/core/interactors/` governed by R13.

Approved runtime hosts use deferred or type-only root imports.
Named Apple facades expose only their governed domain seam.
Type-only platform imports do not expose reusable types.
Platform packages may import contracts, kernel/domain packages, and explicitly injected host capabilities.
They may not import these items:

- Daemon requests or responses.
- Mutable session state.
- Command catalogs or grammar.
- Root implementation files.
- Sibling platform packages.
- Raw process primitives outside the shared host-command port.

R13 covers static, type-only, dynamic, and re-export edges.
Package-owned tests may import their own public façade.
Contracts may depend on kernel vocabulary.
Contracts never depend on concrete platform packages or daemon implementation types.

`@agent-device/platform-android` owns all Android family mechanics.
Its root façade remains metadata-only and lazy.
It exports exactly two implementation facets:

- `./mechanics` exposes named Android behavior to root/core/SDK consumers and package-owned tests.
- `./adb-host` exposes the host port that only `src/platform-runtime-android-adb-host.ts` binds.

The old `src/platforms/android` tree and root shims are deleted.
R13 enumerates these facets and rejects additional Android subpaths or daemon production imports.
These restrictions preserve package closure and explicit host authority without compatibility paths.

The private `@agent-device/capture-kit` package owns durable-capture mechanics shared by more than one implementation.
The enforced direction is `kernel < contracts < capture-kit < platform/provider/daemon`, subject to the substrate amendment below.
Contracts retains pure vocabulary and plan models.
It contains no process supervision, live-handle implementations, recovery helpers, runtime codecs, or capture parsers.
`capture-kit` owns the durable-capture domain; it is not a generic platform-common package.
It preserves lazy implementation loads through package façades.
Its workspace compliance includes `check:affected` selection, R11/R13 package enumeration, and the composite typecheck project list.

> **Amendment (#2082): the substrate below the platform families.**
> Retirement of `src/utils` and `src/platforms` requires a declared domain owner for every shared file.
> Family trees move behind their export maps. The ownership below amends the preceding paragraph to name that layout, instead of letting capture-kit absorb it.
>
> - `@agent-device/host-kit` owns only mechanics that act on the host machine.
>   Each export is one narrow capability port, not a category barrel:
>   - `command`: host command execution.
>   - `process`: host process observation and ownership.
>   - `diagnostics`.
>   - `retry`: deadlines, backoff, and sleep.
>   - `archive`: bounded extraction and byte limits.
>   - `file`: atomic publication, locks, and path resolution.
>   - `request`: request-scoped cancellation and progress.
>   - `transport`: line frames, lazy HTTP/body mechanics, and constant-time secret comparison.
>   - `version`: the installed version from disk.
>   Modules under `src/internal/` are reachable only through a port.
>   A port may contain only mechanics that a consumer of that capability needs.
>   The eager-closure row for each port enforces this restriction.
> - A helper that touches no process, file, or environment is not host mechanics and does not belong in host-kit.
>   These helpers belong to `@agent-device/kernel`, beside its other primitives:
>   - Pure record readers.
>   - Config-source values.
>   - Result text.
>   - Memoization.
>   - Async scopes.
>   - Coordinate validation.
>   - Device-scope parsers.
> - `@agent-device/capture-kit` owns capture, snapshot, and recording behavior:
>   - PNG tooling.
>   - Screenshot density and pixel differences.
>   - Snapshot occlusion.
>   - Mobile snapshot semantics.
>   - Quality verdicts.
>   - Backend capability tables.
>   Snapshot behavior belongs to capture, not contracts vocabulary.
>   Host mechanics belong to host-kit, not capture-kit.
> - `@agent-device/provision-kit` owns preparation of a device and app for execution:
>   - Install-artifact acquisition from local paths, archives, and guarded network downloads.
>   - Host toolchain readiness probes.
>   - Device boot-failure classification.
>   - App-resolution caches.
>   Platform packages may import provision-kit.
>   Provision-kit may not import a platform package.
>   Capture-kit may not import provision-kit.
>   The layering suite tests both prohibited directions with planted violations.
> - The enforced direction is `kernel < contracts < host-kit < capture-kit < provision-kit < platform/provider/daemon`.
> - Contracts retains vocabulary, plan models, and pure classification.
>   The existing planted-red gate prohibits process, filesystem, and timer mechanics there.
>   Each family package owns its platform-specific parsers.
>   Legacy callers reach them through composition.
>   Families never import another owner's internals.
>
> `package-boundaries.test.ts` pins each substrate package's exported subpaths. Additional subpaths fail the gate.
> The contracts mechanics gate retains its planted-red test.
> `retired-platforms-zone` rejects production, test, and fixture files under the former `src/platforms` path.

The Apple package root serves composition only.
It exposes the inventory module, runtime module, shutdown loader, and platform plugin.
Synchronous consumers use named domain facets without a second root compatibility surface.

The Apple XCUITest runner client is a durable implementation facet owned by the Apple platform.
It resides in `packages/platform-apple/src/runner/` (#2040).
R13 enumerates the root façade, the `./runner` subpath, and thirteen named domain/mechanics facades:

- `./app-lifecycle`
- `./app-resolution`
- `./debug-symbols`
- `./doctor`
- `./install-artifact`
- `./macos`
- `./perf`
- `./physical-device`
- `./runner-owner`
- `./runner/operations`
- `./simctl`
- `./simulator`
- `./tool-provider`

Named facades replace root-only access for synchronous domain consumers without a broad compatibility barrel.
R13 pins the exact exports and permitted consumer seams.
The `./runner` façade subpath is the seam through which daemon and root consumers currently reach runner mechanics directly.
The host-bound runner client and its test host remain package-internal.
The `apple-runner` vitest project installs the test host from the package's `__tests__/host-setup.ts`.
The facet owns its cache files and usbmux sockets.
The ambient-host rule exempts exactly this subtree. Raw process primitives remain prohibited.
Host authority still enters through one focused injected port, `AppleRunnerHost`.
Exactly one composition root constructs that port.
The port supplies these host capabilities:

- Process execution.
- Diagnostics.
- Retry.
- Probes.
- Locks.
- Foreground Apple tooling.
- Physical-device control.

No current issue owns migration of the runner's direct consumers behind the composition gateway.
If a migration retires those consumers, the `./runner` seam narrows with them.
The facet is the intended ownership model, not a temporary exception.
Each family explicitly declares mechanics facets.
A new family adds a named facet only with an owning consumer and evidence.
The Apple runner and Android mechanics/host facets are enumerated above.

`@agent-device/kernel/device` declares canonical family, `AppleOS`, public-leaf, and selector identity.
Platform-module metadata references one canonical family.
During coexistence, the legacy plugin registry derives family identity from this same declaration, without a second root.

Focused host capabilities supply command execution, diagnostics, progress, and resolved native assets.
A platform package receives only the capabilities it needs.
Shared logic moves to an honest domain package only after more than one implementation needs it.
There is no `platform-common`, generic host-utilities package, universal command dispatcher, or generic platform-resource union.

#### Implementation-laziness

Static composition must not evaluate every platform implementation at each daemon or CLI startup.
The registry eagerly loads only metadata-only package façades.
Façades defer heavy leaf imports and helper-manager construction through lazy entrypoints:

- Discovery loads mechanics only for a family whose inventory the request selects.
- A binding loads mechanics only for the selected runtime owner.
- Process-lived helper managers are created on first use, not during registry composition.
- A family load does not load an unrelated family's implementation graph.

Composition may eagerly capture inert configured paths.
These activities remain lazy:

- Filesystem and tool probes.
- Asset preparation or builds.
- Helper construction.
- Fact probes that require a selected owner.

The structural suite must prove that unrelated implementations do not evaluate before selected discovery or a selected binding.
The built artifact retains its startup measurement.
A passing startup threshold alone does not replace preservation of the loading shape.
The tracking issue owns the exact probe and planted-red procedure.

### 2. Runtime use joins facts and narrows the bound runtime

`CommandDescriptor` remains the command declaration root.
Its runtime use declares typed required platform-neutral operations.
It may separately name preferred optimizations and fact-conditional semantic operations.
If normalized input determines use, the command first produces a discriminated execution plan.
The plan retains literal required/preferred/conditional types.
The three operation sets are pairwise disjoint.
Preferred operations may improve execution. Command correctness never requires them.

A conditional operation is different.
If an owner advertises a conditional operation, the owner must provide it because the owner's semantically complete path depends on that observation.
If an owner reports it unavailable, parity evidence must prove a complete path through required operations.
This distinguishes correctness that depends on the owner from optimization.
It also avoids an unconditional requirement for owners without that semantic source.

Inventory commands declare separate `inventoryUse`.
`devices` calls the composed `DeviceInventoryGateway`.
The gateway selects canonical family sources and provider-owned inventory sources from request selectors.
It creates no synthetic device and does not call `bindDevice`.
Its coverage denominator is all six local family inventory sources, every provider inventory source, and parity for selector and public-device projections.
An inventory result becomes an ordinary `DeviceInfo` only after its source classifies the canonical family and required leaf identity.

A runtime owner reports exhaustive facts for the exact device shape.
It returns capability-cohesive facets with normalized semantic inputs and typed outcomes.
Facet inputs never contain these items:

- A command name.
- `DaemonRequest`.
- `DaemonResponse`.
- `SessionState`.
- CLI flags.
- An opaque command payload.

A missing facet and typed unavailability fact represent unsupported behavior.
Implementations do not provide stubs that throw `unsupported` after a binding.
Runtime-use keys identify individual semantic operations, not complete facet namespaces.
Selection of one operation exposes no undeclared sibling operation.

**A shape of an operation is not an operation and gets no fact cell.**
Runtime facts describe each semantic operation.
A modifier on an admitted operation, such as a double, held, or repeated press, is not a second operation.
It must not be given a fact key.
The reason is that the facts map is a mapped type over operation names, and a phantom operation satisfies neither the required nor the preferred runtime-use shape.
If the owning leaf mechanic is absent, the shape is refused with a typed reason and a hint, at the point the shape is requested.
Absence of the member for a whole admitted operation remains an ownership bug and fails closed with its own typed reason.
That absence is never the mechanism that expresses an unsupported shape.

**A subject of an operation may carry its own fact.**
An operation may serve a closed vocabulary with unequal owner support, such as `setSetting` over the settings catalog.
Its available fact may name a fact per subject and an `unlisted` refusal for every other subject.
Before a binding, admission uses the requested subject.
It refuses an unavailable subject exactly as it refuses an unavailable operation.
A subject names the requested thing, such as which setting.
A request shape, such as a coordinate form or permission target, still belongs to the owning leaf mechanic described above.

`RequestExecutionScope.bindDevice(device, use)` is the trust choke point.
It performs these steps:

1. Resolve the exact local or provider runtime owner.
2. Check every required operation against facts for the platform leaf, device kind/backend, and provider mode.
3. Classify preferred and conditional operations against those facts.
4. Create or reuse one request binding for that ownership-qualified device.
5. Verify concrete implementations for all required operations and all preferred or conditional operations advertised as available.
6. If an advertised operation lacks an implementation, report a runtime-contract error.
7. Return the selected operation projection.

Required operations are non-optional in that projection.
Declared preferred and conditional operations are optional and present only when available.
Undeclared operations are inaccessible.

The broad cached runtime remains private to `RequestExecutionScope`.
The narrowed type does not intersect a wide optional aggregate that would still expose undeclared facets.
The descriptor and its specialized handler share one non-widened declaration.
A widened generic descriptor supplies no static proof.
A compile-time contract test proves the selected projection.
The **runtime-facet-narrowing gate** covers every runtime-migrated handler owner.
It rejects attempts to manufacture required-operation proof with assertions or optional admission.
Optional access is permitted only for descriptor-declared preferred or conditional operations.
The tracking issue owns the gate implementation and required planted violation.

Absence or failure of a preferred path may change optimization or path disclosure.
It may not change whether the semantic command can execute.
Fallback to the complete required path requires a typed reason and explicit descriptor/ADR 0011 path classification.
A generic `catch` fallback is prohibited.
Helper/session reuse inside one required operation remains internal to that facet under ADR 0002.
It does not become a daemon-visible preferred operation.

Conditional operations do not use that fallback rule.
Their absence is valid only when the owner fact reports them unavailable and parity evidence establishes the required path for that owner cell.
If the fact reports availability, an absent implementation is a runtime-contract failure.
The handler must not silently use a path known to lose the observation.

Family registration and support coverage use separate gates.
The immutable registry owns each of the six canonical families exactly once.
Before a command cuts over, an independent parity artifact freezes the command's legacy supported/unsupported cells and hints.
Runtime-fact scenarios expand canonical kernel-owned family/leaf fixtures across device kinds/backends and provider modes.
A new runtime may not remove a difficult legacy-supported cell. Behavior changes require a separate decision.

Apple coverage uses an exhaustive `AppleOS` fixture table.
It explicitly exercises these cells:

- iOS simulator and physical backends where they differ.
- iPadOS.
- tvOS focus-only/no-coordinate behavior.
- macOS desktop.
- visionOS deferred or supported cells.
- The watchOS unsupported/discovery-absence sentinel.

Each fixture matches exactly one family.
A six-family loop with one generic `platform: 'apple'` device does not prove leaf coverage.

### 3. Provider ownership is exact and fail-closed

Provider resolution for one device has three outcomes:

1. If exactly one provider owns it, bind that provider-owned runtime.
2. If no provider owns it, bind the local family runtime.
3. If multiple providers own it, fail with an ownership-contract error.

Only providers that declare device-runtime ownership participate in this arbitration.
A narrow tool, transport, app-log, or recording provider is an injected dependency of the selected runtime.
It does not become a second runtime owner or participate in the owner count.

Provider ownership is authoritative.
If the owning provider lacks a required fact or facet, admission returns the typed unsupported result.
It never tries the local family implementation.
A provider may implement a complete runtime directly, as Cloud WebDriver can.
It may instead contribute narrow transport inside the owning family module, as an Android transport can.
Provider callback stacks through daemon handlers are not part of the new seam.

Ordinary binding uses the arbitration above.
Each `DeviceBinding` also exposes a unique, restart-stable runtime-owner reference.
It identifies the local family owner or configured provider runtime instance, not merely the provider kind.
Composition rejects duplicate owner references.
Durable descriptors contain this reference.
Exact-owner binding resolves it directly and validates descriptor device/fence identity.
It never repeats ordinary arbitration or `ownsDevice`.
An unavailable expected provider returns `unreattachable: owner-unavailable`.
It never becomes a local bind.

### 4. Bindings attach to process-lived helper managers; they do not own helpers

Platform gateways and helper managers live for the process lifetime.
Under ADR 0002, helper generations remain lazy, identity-bound, invalidatable, restartable, and idle-stoppable.
A request binding attaches cancellation, diagnostics, progress, and admitted device/session context.
Its disposal releases only request attachments and request-local acquisitions.

The underlying `DeviceBinding` implements `AsyncDisposable` and remains private to `RequestExecutionScope`.
Handlers receive only a non-disposable `BoundDeviceRuntime<Use>` projection.
Each gateway bind owns a private rollback stack.
It publishes a binding only after all request-local acquisitions succeed.
If any step fails after an internal acquisition, the bind releases the partial state before it rejects.
Publication transfers ownership exactly once to a repository-owned scope disposal stack that operates in reverse order.
Caching another projection never registers or disposes the binding twice.

Request execution calls the stack from `finally`.
While the minimum supported Node 22 runtime cannot parse `await using`, type stripping cannot lower it, and Node 22 lacks `AsyncDisposableStack`, source-executed TypeScript does not use `await using`.
The contract keeps a later syntax migration mechanical.
A binding is never adopted beyond the request.
Only a durable resource handle that one of the binding's facets returns may transfer to session ownership.

Persistent helper shutdown occurs only through these paths:

- Explicit device lifecycle policy.
- Helper-manager invalidation.
- Platform idle policy.
- Platform-module shutdown after daemon-session resources are finalized.

After adoption, a durable handle may retain its own helper attachment beyond the original request.
This attachment belongs to the handle and is no longer registered for request-scope disposal.
Adoption detaches every original request diagnostic/event/progress port.
Later `finish` or forced disposal uses the current request observability scope or an explicit daemon session-teardown observability scope.
A durable handle never retains an old request async context.

Every helper-backed runtime requires a shared lifecycle contract scenario.
The scenario disables idle expiry and excludes invalidation, process exit, identity change, and ownership transfer.
It proves that request-binding disposal never terminates or restarts the healthy helper.
It also proves that an immediate later binding reuses that generation.
Module shutdown terminates each live, still-owned generation at most once.
Each durable-resource facet separately proves that its adopted resource survives original-binding disposal.
Each platform supplies honest evidence appropriate to its helper. Wall-clock behavior alone is not sufficient.
Bind contract scenarios also fail after each successive internal acquisition.
They prove that an unpublished partial binding leaves no request attachment.

Published bindings are disposed in reverse acquisition order on success, failure, cancellation, and early return.
Unpublished partial binds roll back before rejection.
Disposal occurs inside the active request diagnostics/event context, before these events:

- `request.finished`.
- Diagnostics flush.
- Final response construction.
- Device/session lock release.

Thus, cleanup-only failure cannot follow recorded success.
If operation and cleanup both fail, the operation error remains primary.
Cleanup becomes structured secondary diagnostic evidence.
A cleanup-only failure surfaces normally.

### 5. Durable resources are reattachable by the same owner

> **Proposed amendment (ADR 0024, 2026-09-14), `screen-recording` only.**
> Screen recording would be a *stop-and-collect* resource.
> Its artifact is a file that the native recorder finalizes on signal.
> Only signal time permits renewed proof of recorder identity.
> It would retain the persisted manifest, ownership fences on every destructive step, and completed replay.
> Backend `stop(target, budget)` and `collect` would replace the `reattach` and `cleanup` facet operations.
> This kind would remove the `cleanup-pending` phase and admission ledger.
> It would record the recorder observation and native-path disposition beside the committed export.
> A manifest would remain archived by fence generation until both are settled.
> For each durable kind, failed finish would no longer imply forced cleanup once its failed-finish test states its retry requirements.
> App-log, audio-probe, and perf-capture would retain the contract below unchanged.
> ADR 0024 contains the rationale, matrix, and tests.

App-log streams, screen recordings, and native profiler captures may outlive one request.
A durable start returns two values:

- A **live resource handle** supplies process-local authority to finish or forcibly dispose the active resource.
- A **durable resource descriptor** supplies bounded, JSON-safe, versioned state that is sufficient for a deterministic recovery attempt by the exact runtime owner.

Facet-specific handles expose these operations:

- `finish(): Promise<FinishOutcome>` for idempotent normal completion.
- `forceCleanup(): Promise<CleanupOutcome>` for forced cleanup with an outcome.
- Idempotent `[Symbol.asyncDispose](): Promise<void>` as the scope-cleanup adapter.

The adapter resolves only for confirmed cleanup or already-missing outcomes.
Otherwise, it rejects with a normalized ownership-lost or cleanup-pending error.
`Promise<void>` does not carry a typed result.

Each destructive finish/cleanup operation holds the authoritative ownership lease across fence validation, native side effect, and persisted lifecycle transition.
Alternatively, it passes a fencing token to a native/provider operation that atomically rejects stale owners.
A check immediately before the side effect is insufficient.
A transport without either mechanism cannot claim transferable reattachment.
Cleanup-only recovery then requires proof that the prior owner is gone.
Otherwise, recovery remains manual.

If a facet start cannot publish a complete handle/descriptor pair, it rolls back internally.
The request scope invokes the start promise through its pending-transfer guard.
Before command orchestration receives the result, the scope registers the guarded handle for forced cleanup.
The scope releases that guard only after the authoritative active record and live `SessionState` handle/descriptor adoption both succeed.
Cancellation or failure in this interval disposes the unadopted handle.
The record becomes terminal only after confirmed cleanup.
Uncertain cleanup leaves the record cleanup-pending.
Contract scenarios inject cancellation and failure between partial start, publication, persistence, live adoption, and transfer.

There is no generic `PlatformResource`.
Live `SessionState` may retain a neutral facet-specific contract handle beside its descriptor and metadata.
One R7 transition owner owns the field.
Only the descriptor and neutral metadata enter the authoritative persisted recovery record.
Neither store contains these values:

- Concrete platform classes.
- Provider clients.
- Child handles.
- Timers.
- Transports.
- Wait promises.

One daemon `DurableCaptureResource` coordinator shares lifecycle mechanics across facet-specific resources.
It owns bounded manifest I/O, per-resource fence serialization, start/persist/adopt compensation, terminal transitions, and deadline-bounded exact-owner recovery.
It receives these facet-specific inputs:

- Resource kind and manifest store.
- Neutral session slot.
- Completion metadata projection.
- Failure wording.
- Exact-owner recovery adapter.

It does not select platforms or interpret command flags.
It does not form a generic runtime facet.
App-log and screen recording retain separate handles, descriptors, facts, native finalization semantics, and admission policy.
Reusable codec/live-handle mechanics below the daemon remain in `@agent-device/capture-kit` to preserve package direction.

A daemon-owned admission ledger with process lifetime may retain bounded cleanup uncertainty that has no honest durable representation.
The ledger is not a second live-resource store.
It contains no handle or descriptor and never supersedes the persisted manifest.
When canonical device identity is known, that identity keys the ledger.
Admission revalidates evidence that permits another check, such as a retained legacy marker path.
Thus, manual recovery can unblock the matching device without a daemon restart.
Unknown-identity evidence remains globally fail-closed.
In-memory blocks without durable evidence expire only under an explicit bounded policy with diagnostics.

Persisted JSON re-enters as `unknown`.
Contracts first validate a neutral envelope with these fields:

- Resource kind/envelope version.
- Session/device identity.
- Exact owner reference.
- Fence.
- Lifecycle state.

Only after exact-owner selection does the facet's total codec decode the descriptor body.
Invalid or unknown envelopes/bodies remain recovery evidence with typed `descriptor-invalid`/`descriptor-version-unsupported` outcomes.
They are never cast to a descriptor, deleted, or offered to another facet.

If no live handle is available, the daemon completes lease/admission and takeover fences.
It then binds the descriptor's exact owner and calls the facet's typed `reattach`.
Reattachment returns one closed outcome:

- `active` with a handle.
- `completed` with its result.
- `missing`.
- `unreattachable` with a typed reason.

Unsupported schema/version returns `unreattachable: descriptor-version-unsupported`.
The facet does not guess a migration, discard the descriptor, try another owner, or start a replacement.
Other closed reasons include `owner-unavailable`, `transport-not-reattachable`, and `ownership-fence-lost`.
If native transport cannot reconstruct equivalent live control, a descriptor may explicitly declare cleanup-only recovery.
This limit is a runtime fact, not an assumption during takeover.

Reattachment does not reconstruct `SessionState` or change `SESSION_NOT_FOUND` policy.
Without an admitted live session, the recovery scope owns the reconstructed handle.
It may only complete or clean up the resource.
Continued session use requires an independently admitted live session.

Each durable facet also exposes typed, idempotent `cleanup(descriptor, fence, scope): Promise<CleanupOutcome>` for descriptor-only forced cleanup.
Cleanup-only recovery uses this operation without reconstructing a full handle.
Its closed outcome records cleaned, already missing, or still cleanup-pending state.
Finish, dispose, and descriptor cleanup share the serialized or atomically enforced fence.
If the exact owner or schema is unavailable, cleanup cannot be inferred.
The authoritative record remains cleanup-pending with a manual-recovery reason.

Before command start success returns, the descriptor must have an authoritative persisted home.
Prefer an existing platform/resource-owned recovery manifest.
If a resource has no honest manifest, introduce a daemon-owned persisted resource record only for that demonstrated need.
Extract a shared resource index only after multiple resource types require it.
Current diagnostics/session events and a future journal from proposed ADR 0018 serve observability only.
They never become recovery authority.
They may mirror descriptor lifecycle events.
Reattachment never scans telemetry to reconstruct state.

Each authoritative home exposes deterministic facet-owned lookup or enumeration after process loss.
Its neutral record contains these values:

- Session/device identity.
- Exact runtime-owner reference.
- Descriptor and metadata.
- Ownership/fence token.
- Persisted lifecycle state: `open` or `completed`.

In-progress distinctions, for example starting, active, completing, and cleanup-pending, are phase metadata on the open record, not additional lifecycle states.
The fence and descriptor remain authoritative across all open phases.
Cleanup uncertainty cannot be a terminal lifecycle.
A new handle remains private until acquisition of the persisted ownership fence.
Each finish/cleanup attempt holds the guard across destructive work and the persisted transition.
Alternatively, the attempt delegates to an operation that atomically enforces the token.
These mechanisms prevent a previous owner from terminating a transferred resource.

Descriptor persistence does not make external-resource start and descriptor write atomic.
If a native tool cannot close this crash interval, the platform retains a platform-owned orphan marker or equivalent recovery protocol.
Descriptors contain stable reconstruction coordinates.
They contain no promises, timers, child handles, buffers, credentials, or dump of live implementation state.

Ownership transfer is explicit.
Start persists active recovery evidence before command success.
The pending guard transfers only after live session adoption.
Completion preserves a terminal result or stable result coordinates before removal of active recovery evidence.
After adoption, request-binding disposal cannot stop the resource.
Normal session teardown preserves facet-specific order.
Adopted handles do not enter the request binding's generic disposable transaction.

### 6. Command execution has one closed shape

Each descriptor declares command identity and one internal-only execution mode, excluded from public projections:

- `none`
- `host`
- Device `runtimeUse`
- `inventoryUse`

A `none` descriptor never binds a device or carries capability admission.
It owns no platform adapter and declares no runtime or inventory use.
Each descriptor explicitly declares its mode. The registry has no default.
ADR 0003's daemon-owned route table independently owns handler and request-policy traits.

During adoption, the abandonment-safe migration unit was one command descriptor across its complete platform/provider denominator.
A temporary parametrized cutover table proved that each unit deleted its old adapter, admission, and dispatch projections before merge.
Those rows were deleted after the final unit completed.
The permanent union cannot express `legacy`.
Descriptors cannot carry capability admission.
R66 rejects manufactured runtime proof and restored legacy admission.
R65 rejects every daemon dependency on a concrete platform implementation.

Migrated and legacy commands do not duplicate shared Apple-runner or Android-helper mechanics.
They do not connect to these mechanics through a package-to-root back-import.
Either these mechanics remain physically in place until their last consumer can move, or they move behind a neutral lower-level capability.
Composition injects that capability into both the package facet and the complete legacy adapter.
Command execution ownership remains singular.

Review the behavior-neutral package/registry substrate and each command unit from a clean committed tree with all production files present in `HEAD`.
A passing layering check with untracked production files is not evidence.
Platform packages receive no migration allowlist or root back-import exception.
Temporary fixtures never authorize a production bridge, a duplicate route, or a recorded package back-import.
For a `packages/platform-*` change, `check:affected` must select platform contract, provider, and coverage scenarios.
A new structural gate requires a planted violation that proves the intended failure before acceptance.

Any unit that touches `SessionState` classifies each changed field once under R7.
It excludes request bindings, concrete platform/provider types, and raw process/transport mechanics.
Each mutable resource field has one transition owner.
The only permitted live value is the opaque implementation behind a neutral facet-specific handle contract.
The unit proves partial-start cleanup, transfer, finish, forced disposal, and error precedence.
If equality-pinned R10 writer/owner counts shrink, lower them in the same unit.
If external `daemon/types.ts` importer membership shrinks, lower it in the same unit.
R9 total-cycle pressure and R10 cycle-zone pressure may not grow.
R9 is equality-pinned since #1781 A6.
If a unit shrinks the cycle, it lowers zone ceilings in the same change without unused allowance.

### 7. Adoption checkpoint (historical)

Git history retains the completed checkpoint procedures and results.

### 8. Broader migration was move-dominated and evidence-tiered

The checkpoint and recordings budgets paid for machinery that later units reuse.
They are not a precedent for growth.
Every post-checkpoint unit still defines its original-baseline cumulative bound and its immediate stack-base delta.
The default expectation is the inverse of those budgets.
A unit moves existing platform mechanics from root `src/` into platform packages and deletes superseded daemon code.
Thus the shipped-size delta of the unit trends to zero or negative.
The review of the unit reports root bytes removed against package bytes added.
Net growth is exceptional.
If net growth occurs, the unit names and justifies each contributing addition individually.
Contract modules stay vocabulary-thin under the existing capture-kit rule.
Per-unit type inflation is size growth, and review treats it as size growth.
Raw per-unit parity, planted-red, and size evidence belongs in #1739 and its PRs.
A unit must not treat the checkpoint budget as an allowance.

A smaller design with root re-export shims, a broad barrel, or ambient filesystem/process access would reduce gross source movement.
It would violate these constraints of this ADR: package closure, no compatibility shims, named facets, host injection, and implementation laziness.

Evidence requirements followed the imports of each unit.
A **request-scoped device unit** used facts and operations only.
It proved its typed declaration and every fact cell.
A **durable-resource unit** additionally supplied the complete lifecycle evidence from sections 4–5.
These tiers remain review vocabulary for future runtime changes. They do not restore the migration ledger.

Completion retired the cutover table.
Facts are the only support authority for device commands.
Permanent R66 policy rejects descriptor capability buckets, `requireCommandSupported` calls, and manufactured or repaired narrowed runtime proof.

### 9. Binding ergonomics: one bind per handler

The gateway exposes facts inspection without side effects for a device with resolved ownership.
It answers admission, `capabilities`, and doctor questions without a request binding, helper acquisition, or device access.
It shares the owner's lazy loads.
A handler binds exactly once with the execution use selected by its plan.
New units may not introduce admission-only binds with an empty required set to read facts.
A change from an already-migrated handler to facts inspection changes production admission behavior.
It is a separate unit with its own independent review and parity evidence.
It is never a side effect of a structural change.

One second bind per request is permitted, and it is not the retired admission-only idiom.
A post-action observation (`--settle`) whose action use has no capture admits the `capture-only` plan for its own reads (#3510).
It never reads facts through a binding.
It admits through the facts probe and binds only after admission.
If the action already requires `captureSnapshot`, it projects the cached request binding instead of acquiring another.
This includes `scroll top|bottom` and `scroll --until`.
The second bind remains capture-only.
A second bind with a mutating operation is the execution use that the plan should have selected.

Use declarations share one neutral `defineUse`.
Do not add per-domain currying wrappers; they add one module per domain without additional information.
Required-only declarations are the default.
A preferred operation requires a recorded measurement of its fast-path benefit in the unit review.
The direct-selector fast path provides the model.
Review rejects preferred operations without measurements as speculative surface.

A conditional operation instead requires a parity artifact for both owner-cell groups:

- Cells whose semantic path depends on the operation.
- Cells whose required path remains complete without it.

A conditional declaration justified only by speed belongs under `preferred`.
A conditional declaration justified only by universal correctness belongs under `required`.

### 10. Process-lifetime and cross-cutting surfaces

A cross-cutting facet serves more than one command execution path.
Examples include snapshot freshness, the system-chrome guard, presentation rules, and runtime hints.
It accompanies the first consuming command unit and appears in that unit's review.
Its contract has one owner.
Later units consume that facet.
A parallel contract for the same concern is a seam violation.
A facet PR without a consuming command is prohibited.

Daemon startup gains no per-platform entrypoints.
Persisted durable manifests and platform-owned markers are the only triggers for startup recovery.
A family's mechanics load only when its evidence exists.
A family without evidence never evaluates, which preserves implementation laziness.
App-log recovery provides the model.
Remaining platform-specific startup recovery, for example the Android test-IME marker and web browser orphans, moves to this pattern when its owning domain migrates, not earlier.

Daemon shutdown uses two gateway phases:

1. Before daemon session teardown, detach offers each process-lived helper manager its handoff policy.
   A healthy kept-hot helper may transfer to a successor daemon.
2. After session resources finalize, stop terminates each still-owned generation at most once, as section 4 requires.

Daemon runtime no longer calls platform-specific shutdown directly.
Owners participate through these phases.

Session teardown retains isolated steps and has no generic hook API.
Each domain owns its cleanup step:

- Test-IME restoration is durable device state with marker-based recovery.
- Helper stops follow the owning platform module's lifecycle policy.
- Close-time cleanup consumes neutral owner services.

R65 enforces the daemon end state through planted-red AST tests.
It rejects static, dynamic, re-export, and type-only dependencies from production `packages/daemon/src/**` to `src/platforms/**` and concrete `@agent-device/platform-*` packages.
It excludes test files, consistently with the layering scanner.
R13 governs concrete package imports across the repository.
`retired-platforms-zone` prevents restoration of the old root seam.
These gates enforce platform independence structurally, without periodic measurements.

### 11. The platform-services port carries host asks that bind no device

Some request work needs host information without a device runtime:

- Concrete local readiness.
- Boot-time and runner-session observations.
- Open-target classification.

One required dependency carries these requests across the daemon boundary: `DaemonPlatformServices`.
`packages/daemon/src/core/platform-services.ts` declares it, and `@agent-device/daemon` exports it.
Root composition in `src/daemon-composition.ts` assembles it through `src/platform-runtime-daemon-services.ts` with a function-scoped `await import`.
It passes through composition, `startDaemonRuntime` dependencies, `RequestRouterDeps`, and the request execution scope to handlers and consumers.

Stale-claim reconciliation uses the same pattern for the one act that it may not perform itself.
The daemon declares `ClaimRecoveryGatewayFactory` in `packages/daemon/src/resources/device/claim-recovery-gateway.ts`.
Composition supplies it from deferred `src/platform-runtime-claim-recovery.ts`.
The daemon retains the transaction: the dead owner's recorded state directory, reconstruction order, and disposal time.

The port does not expose raw platform mechanics.
Its observation members use published neutral contract types from `@agent-device/contracts`.
Readiness is a boolean.
The port declares three open-target questions over neutral `DeviceInfo`, flag strings, and `SessionSurface` inputs.
No member carries a raw selector, gesture, or runner call.
No signature contains a platform type.
Device execution remains on `RequestExecutionScope.bindDevice`.
Owner facts remain the only admission authority.

All port members are required.
There is no throwing placeholder for a process without composition.
A daemon receives root composition or cannot start.
Tests pass the same shared fixture instead of a platform-module mock behind the port.

## Relationship to prior decisions

- [ADR 0001](0001-provider-first-integration-scenarios.md): provider-first scenarios and semantic provider operations remain.
  Command migration supersedes the monolithic `Interactor` and request callback-stack topology.
- [ADR 0002](0002-persistent-platform-helper-sessions.md): persistent-helper protocols, invalidation, and explicitly safe one-shot fallback remain.
  Daemon ownership means lifetime policy.
  Platform modules own helper managers/mechanics. Request bindings never own helpers.
- [ADR 0003](0003-daemon-command-registry.md) and [ADR 0007](0007-remote-device-leases.md): request-policy traits, lease admission, and lock order remain daemon-owned.
  A binding occurs only after their admission requirements pass.
- [ADR 0008](0008-command-descriptor-registry.md): the descriptor registry remains the command root.
  Device capability buckets become typed required/preferred/conditional runtime use with exact runtime facts.
  Inventory commands declare inventory use.
- [ADR 0009](0009-apple-platform-consolidation.md): the Apple family and `AppleOS` leaf axis remain.
  Command migration supersedes the shallow `PlatformPlugin`.
  Shared physical mechanics move only behind a neutral lower-level capability that composition injects, or after their final legacy consumer.
- [ADR 0010](0010-error-system.md): normalized errors remain.
  This ADR adds operation/cleanup precedence and typed reattachment outcomes.
- [ADR 0011](0011-interaction-guarantee-contract.md), [ADR 0013](0013-unified-gesture-plans.md), and [ADR 0014](0014-session-ref-frame-lifetime.md): interaction paths remain separate.
  Normalized gesture plans cross the seam.
  Daemon authorization expires immediately before any possibly mutating facet call.
  Platform implementations may not hide UI mutation inside an observational facet.
- [ADR 0018](0018-unified-event-journal.md) remains proposed and is not a dependency.
  If accepted, its journal and teardown scopes may implement this ADR's observability contexts.
  They remain observation, not coordination or persisted recovery state.

## Consequences

The daemon retains these responsibilities:

- Policy and command semantics.
- Response construction.
- Session/lease ownership.
- Selector/ref authority.
- Interaction guarantees.
- Artifact orchestration.

Platform packages colocate native mechanics, provider transport composition, persistent helpers, and resource recovery.
A new platform implements existing runtime contracts and facts instead of new daemon tags, maps, callbacks, and branches.

The cost was a staged cross-repository migration with temporarily coexisting execution systems.
Command-atomic cutover, explicit deletion boundaries, and the early adoption checkpoint kept each intermediate state shippable and safe to abandon.
The completed repository retains only closed execution shapes and permanent structural policies.

## Alternatives considered

- **Move all platform source into packages first:** rejected.
  This changes physical ownership before proof of the behavior seam.
  It creates large root-import paths and prevents command-by-command review or abandonment.
- **Keep extending `PlatformPlugin` with tags and predicates:** rejected.
  This moves selection data but leaves the daemon responsible for each tag-to-behavior map.
- **One replacement `Interactor`, universal dispatcher, or `SystemFacet`:** rejected.
  Support differs by operation across platform leaves.
  A broad optional interface restores unsupported stubs and platform code that knows commands.
- **Provider/local or old/new execution fallback:** rejected.
  Provider ownership and command cutover must be exact.
  Success-path fallback hides semantic differences.
  ADR 0002 continues to govern explicitly accepted internal helper fallbacks.
- **Use session events or a future journal as the durable-resource store:** rejected.
  Correctness would depend on observability.
  Current events are projections. Proposed ADR 0018 also prohibits state reconstructed from events.
- **A separate process-local resource ledger beside `SessionState` for live handles:** rejected.
  The in-memory session store already supplies the process-local home.
  A parallel handle/descriptor store would duplicate ownership that the R7 transition owner governs.
  The accepted admission ledger contains only bounded cleanup-block evidence.
  It contains no live handle or descriptor and never replaces the authoritative manifest.
- **Rely only on performance thresholds for lazy loading:** rejected.
  Thresholds detect regressions late and can pass despite unrelated implementation loads.
  Contract tests also verify the import/evaluation shape.

## End state (proposed 2026-09-02, maintainer decision pending)

The targets below are proposed defaults, not an accepted commitment.
No tracking issue or Status line authorizes work against them yet.
They provide a numeric baseline for the next migration wave and remain open for revision or rejection.

**Daemon top-level footprint.** `git ls-tree --name-only origin/main src/daemon/ | grep -E
'\.ts$' | grep -vE '\.test\.ts$' | wc -l` measured 199 production files at `e624ef9d3f`.
The proposed target is ≤ 60.
`packages/daemon/src/**` remains a permanent R65 zone.
The target concerns its remaining contents, not directory retirement.

**Entry-to-platform hop count.** The measurement was corrected on 2026-09-03 and repeated for #2278 at `27a97ee619`.
[`0023-end-state-hop-trace.md`](./0023-end-state-hop-trace.md) contains the definition, ordered chains, roles, and measured commit.
It supersedes the earlier numbers below.
A file-by-file re-trace at that HEAD measured 41 hops for `press`/Android and 47/49 for `snapshot`/iOS.
The snapshot route shares 30 hops, with 17/19 per arm: in-simulator AX bridge primary and XCTest runner fallback.
The earlier 38/29 counts had no ordered chain, definition, or artifact and do not reproduce.
They are superseded, not another data point.

Decision sections 1–2 declare `src/platform-runtime.ts` and each façade's `loadRuntime` pair as boundaries, not pass-through layers.
They remain in every hop count regardless of target.
Other traced hops are pass-through candidates only where R13's named facets and the package direction already allow their collapse:
`kernel < contracts < host-kit < capture-kit < provision-kit < platform/provider/daemon`.
A hop that exists only to satisfy that direction is not waste.
The deletion test at the traced HEAD proves one distinct removable hop across both routes: `commands/runtime-types.ts`.
The earlier ≤ 14 target is **superseded and not reachable** without a decision to fold cross-cutting request-scope wrappers.
That decision is outside the traced routes' ownership.
The number 14 remains a historical discussion reference, not a proposed commitment.

**Zones still under `src/` that this ADR expects to leave, and their package status:**

- `src/platform-runtime-*.ts` has approximately 70 Android/Apple/screen-recording/perf/network/app-log/app-state/toolchain/device-inventory host files.
  Ownership is mixed.
  Android deployment, logs, network, perf, readiness, recording, and shutdown already have homes in `packages/platform-android/src/`.
  Apple equivalents reside in `packages/platform-apple/src/`.
  Remaining root files are either declared host-port adapters or mechanics whose migration is incomplete.
  For example, `adb-host` is a declared host-port adapter that only its named root file binds, per Decision section 1.
  Filenames do not distinguish these roles.
  A target requires per-file classification first.
- `src/recording`, `src/snapshot`, and `src/snapshot-quality` migrated to `packages/capture-kit/src/` on 2026-09-07.
  This includes `recording/`, `snapshot/`, its `snapshot-presentation/` and `snapshot-freshness/` subtrees, and cross-package `warnings.test.ts`.
  Four former `src/core/` modules and their tests joined the package root:
  - `snapshot-chrome.ts`
  - `snapshot-state.ts`
  - `snapshot-tree-ingestion.ts`
  - `snapshot-node-lookup.ts`
  External daemon, command, platform-host, and integration consumers use package subpaths.
  Examples are `@agent-device/capture-kit/snapshot-lines`, `/recording-video`, and `/ios-snapshot-runtime`.
  `snapshot-tree-ingestion` has no subpath because only the same-package `snapshot-state.ts` consumes it.
  Three tests remain at the root:
  - `src/core/__tests__/snapshot-state.test.ts` and `snapshot-chrome-android-statusbar.test.ts` are pinned to root-owned `interaction-targeting` and the Android UI-hierarchy fixtures.
  - `src/__tests__/snapshot-desktop-surface.test.ts` depends on root eager-import-closure fixtures.
- `src/screenshot-diff/*.ts` and its test migrated to `packages/capture-kit/src/` beside the pixel worker and screenshot overlays.
  This covers region split, overlay, summarization, and component composition.
  CLI and command output use `@agent-device/capture-kit/screenshot-diff`, `/screenshot-diff-regions`, and `/screenshot-diff-overlay-matches`.
- `src/provider-device-runtime.ts`, `src/provider-device-runtimes.ts`, `src/provider-limrun-runtime.ts`, and `src/provider-webdriver.ts` are mostly thin composition modules.
  Most WebDriver and Limrun logic resides in `packages/provider-webdriver/src/` and `packages/provider-limrun/src/`.
  The root modules serve a composition-time role comparable to `src/platform-runtime.ts`.
- These zones are not migration targets:
  - `src/core`, with R13-governed consumer seams.
  - `src/commands`.
  - `src/cli`.
  - `src/cli-schema`.
  - `src/mcp`.
  - `src/client`.
  - `src/sdk`.
  - `src/ai-sdk`.
  - `src/remote`.
  - `src/request`.
  This ADR intentionally retains these command-surface, protocol-projection, and daemon-owned zones under `src/`.
- `@agent-device/react-native` owns React Native development tooling:
  - Metro preparation and session bindings.
  - Companion tunnels.
  - Component inspection.
  - Render profiling.
  CLI output and SDK session normalization remain application adapters under `src/`.

Neither number has an owning issue, gate, or accepted budget yet.
Both remain inputs to a maintainer decision, not a ratchet.
