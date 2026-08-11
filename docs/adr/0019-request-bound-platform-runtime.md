# ADR 0019: Request-Bound Platform Runtime

## Status

Accepted for staged adoption (2026-08-09). Checkpoint outcome: **continue** (2026-08-10), under the
revised cumulative package budget accepted in issue 1704. The clean checkpoint is measured from the
original baseline `44c298d7f3a0ef84bc47f34c54d88b6c9eeb0df2`, through merged `devices`
`c06bed9f773a27ae0a02cb012570def2f2d0b90e`, to `logs`
`188795386466cfdba5d5748db5c9d3477e70eb4e` and `network`
`457fafe6399a95a4ddbfac57f02b3a7fe4157a54`. The earlier checkpoints at `99f5af1b7` and `d73bdb4ae`
are superseded and were not behavior-passing: later review found correctness failures and the first
budget decision still used the unrevised +3% limit. The required cleanup package, explicit budget
decision, and clean rerun are now complete. The recordings command unit has since completed on the
durable-capture substrate under its separately reviewed cumulative bound below (section 7). No
further command unit is authorized by this Status: subsequent units are planned, budgeted, and
authorized individually through the successor tracking issue under the amendment's governance.

Amended 2026-08-11 with broader-migration governance (sections 8–10). The amendment changes no
checkpoint outcome and re-authorizes nothing by itself: command units still migrate one at a time
under sections 2–6, but subsequent units follow the move-dominated size discipline, the evidence
tiers, the binding ergonomics, and the process-lifetime rules added below.

During the `devices` unit, doctor discovery, replay-test sharding, Apple simulator hints, and Android
emulator lifecycle keep their existing command execution owners while consuming the same injected,
neutral inventory capability. That coexistence moves discovery mechanics once; it does not migrate
those descriptors or authorize a second local/provider chooser.

## Rules at a glance

- Daemon device-execution code depends on platform-neutral contracts. Concrete device mechanics
  live in private `@agent-device/platform-*` packages and are value-imported only by the root
  composition module.
- The platform registry is **metadata-eager and implementation-lazy**. Cheap family identity,
  inventory entrypoints, and static fact declarations may load at composition time; platform
  mechanics and process-lived helper managers load only when discovery or the first binding for that
  family needs them.
- The registry selects one local runtime owner per canonical platform family. Support is claimed and
  tested for the exact platform leaf, device kind/backend, and provider mode; family ownership never
  implies uniform leaf support.
- Command descriptors declare one typed execution shape: inventory use, or platform-neutral required
  device operations with separately declared preferred fast paths. Runtime owners report
  device-specific facts and expose behavior-bearing facets; platform and provider implementations
  never name commands.
- `RequestExecutionScope.bindDevice(device, use)` resolves provider ownership, validates the facts
  and concrete facets, and returns a runtime type narrowed to the proven runtime use. Handlers cannot
  use undeclared facets or repair missing proof with casts or non-null assertions.
- Provider ownership is first-class and fail-closed. An owning provider may supply transport to a
  platform runtime or implement facets directly; missing required behavior never falls through to a
  local owner.
- Process-lived helper managers, request-lived device bindings, and daemon-session durable resources
  have distinct lifetimes. Helper instances remain lazy, identity-bound, invalidatable, and
  idle-stoppable. Disposing a request binding never stops a healthy helper or adopted resource.
- Durable work has two representations: a process-local live handle and a versioned, persistable
  descriptor through which the same runtime owner can recover. Live session state may own a neutral
  facet handle under R7; only the descriptor and neutral metadata enter persisted recovery state.
  Concrete platform process objects never cross the seam.
- The migration unit is one command descriptor across its full existing denominator: every inventory
  source or every supported device-runtime cell. A descriptor has exactly one explicitly declared
  platform-execution shape at every committed state — `none`, legacy, inventory-backed, or
  device-runtime-backed — and a migrated command has no legacy execution fallback. `none` declares
  the absence of platform execution and is never a migration target or source.
- Broader adoption pauses after the first real slices. Evidence records one decision: continue,
  revise the seam and rerun the checkpoint, or stop with every landed command still coherent.
- Post-checkpoint units are move-dominated: platform mechanics leave root `src/` for platform
  packages, net shipped-size growth is exceptional and individually justified, and surfaces already
  scheduled for removal at the next major are deleted on legacy, never migrated.
- Evidence is tiered by what a unit imports: request-scoped device units prove facts, operations,
  and parity cells; only durable-resource units carry the section 4–5 lifecycle evidence.
- A handler binds once with its execution use. Admission, `capabilities`, and doctor questions use
  side-effect-free facts inspection; required-only declarations are the default and a preferred
  operation requires a recorded measurement.
- Cross-cutting facets land with their first consuming command unit. Daemon startup recovery is
  evidence-gated, daemon shutdown is two-phase (detach, then stop), and session-teardown steps
  belong to their owning domains — there is no generic lifecycle-hook API.

## Context

ADR 0009 deliberately introduced a shallow `PlatformPlugin`: it wrapped the existing platform
branches, preserved their lazy imports byte-for-byte, and moved each daemon column only after a
parity gate proved equivalence. That was the right migration shape. It stopped platform conditionals
from spreading, but its app-log, recording, performance, and provider facets still return tags or
predicates that the daemon maps back to concrete implementations.

The canonical registry now has six families: `apple`, `android`, `harmonyos`, `vega`, `linux`, and
`web`. HarmonyOS supplied the additional real adapter pressure that the earlier platform-package
checkpoint deliberately deferred. With this many families, a tag-to-implementation map leaves the
daemon owning every platform variation even when the platform conditional has moved behind a
plugin.

The replacement must preserve the properties paid for by the existing architecture: daemon-owned
request policy, provider-first integration scenarios, Apple-family leaf modeling, kept-hot helper
performance, interaction guarantee honesty, pre-mutation ref-frame expiry, normalized errors,
package direction, and CLI cold-start laziness.

## Decision

### 1. Platform modules provide behavior through one composition seam

Each canonical family has one private `packages/platform-<family>` workspace package named
`@agent-device/platform-<family>`. Its façade exposes cheap metadata plus lazy implementations of a
`DeviceInventorySource` and `DeviceRuntimeGateway`; the implementations behind those entrypoints own
platform tool invocation, helper protocols, runtime facts, output parsing, recovery mechanics, and
other native details. A platform package contains only that family's implementations and mechanics,
never daemon orchestration, command policy, or cross-family defaults.

The root composition module, `src/platform-runtime.ts`, constructs immutable
inventory/runtime registries and injects a composed inventory gateway plus provider-first runtime
gateway into daemon request execution. Daemon device-execution modules import runtime contracts only.
Shared runtime interfaces and neutral data types live in `@agent-device/contracts`. In production,
only that composition module may import a concrete platform package; reusable types do not leak
through type-only platform imports. Platform packages may import contracts, kernel/domain packages,
and explicitly injected host capabilities; they may not import daemon requests or responses, mutable
session state, command catalogs/grammar, root implementation files, sibling platform packages, or raw
process primitives outside the shared host-command port. R11 applies these rules to static, type-only,
dynamic, and re-export edges; package-owned tests may import their own public façade. Contracts may
depend on kernel vocabulary but never on concrete platform packages or daemon implementation types.

Durable-capture mechanics shared by more than one implementation live in the private
`@agent-device/capture-kit` workspace package, with the enforced direction
`kernel < contracts < capture-kit < platform/provider/daemon`. Contracts retains pure vocabulary and
plan models; process supervision, live-handle implementations, recovery helpers, runtime codecs, and
capture parsers do not live there. `capture-kit` is a domain package for durable capture, not a generic
platform-common package, and it preserves the package façades' implementation-lazy loading boundary.
Its introduction carries the normal workspace-package compliance surface: `check:affected`
selection, R11/R13 package enumeration, and the composite typecheck project list.

Canonical family, `AppleOS`, public-leaf, and selector identity remain declared in
`@agent-device/kernel/device`. Platform-module metadata references one canonical family; during
coexistence the legacy plugin registry derives its family identity from the same declaration rather
than becoming a second root.

Host command execution, diagnostics, progress, and resolved native assets enter through focused host
capabilities. A platform package receives only the capabilities its implementation needs. Shared
logic moves to an honest domain package only after more than one implementation needs it; there is
no `platform-common`, generic host-utilities package, universal command dispatcher, or generic
platform-resource union.

#### Implementation-laziness

Static composition must not make every daemon or CLI startup evaluate every platform implementation.
The registry eagerly loads only metadata-only package façades. A façade keeps heavy leaf imports and
helper-manager construction behind lazy entrypoints:

- discovery loads mechanics only for a family whose inventory is requested;
- binding loads mechanics only for the selected runtime owner;
- process-lived helper managers are created on first use, not while composing the registry; and
- loading one family does not load an unrelated family's implementation graph.

Composition may capture inert configured paths eagerly. Filesystem/tool probing, asset preparation or
building, helper construction, and facts requiring a selected-owner probe remain lazy. The structural
suite must prove that unrelated implementations are not evaluated before selected discovery/binding,
and the built artifact retains its startup measurement. Passing a startup threshold alone is not a
substitute for preserving the loading shape; the tracking issue owns the exact probe and planted-red
procedure.

### 2. Runtime use joins facts and narrows the bound runtime

`CommandDescriptor` remains the command declaration root. Its runtime-use declaration has a typed set
of required platform-neutral operations and may separately name preferred optimizations. Commands
whose use depends on normalized input first produce a discriminated execution plan that retains
literal required/preferred types. Required and preferred operation keys are disjoint, and the
required-only path is semantically complete; preferred operations may improve execution but are
never necessary for command correctness.

Inventory commands have a separate `inventoryUse` declaration. `devices` calls the composed
`DeviceInventoryGateway`, which selects canonical family sources and provider-owned inventory sources
from the request selectors; it neither invents a synthetic device nor calls `bindDevice`. Its
coverage denominator is all six local family inventory sources, every provider inventory source, and
selector/public-device projection parity. Inventory results become ordinary `DeviceInfo` values only
after their source has classified the canonical family and required leaf identity.

A runtime owner reports exhaustive facts for the exact device shape and returns capability-cohesive
facets with normalized semantic inputs and typed outcomes. Facet inputs never contain a command name,
`DaemonRequest`, `DaemonResponse`, `SessionState`, CLI flags, or an opaque command payload. A missing
facet plus a typed unavailability fact represents unsupported behavior; implementations do not ship
stubs that throw `unsupported` after binding. Runtime-use keys identify individual semantic
operations, not whole facet namespaces, so selecting one operation does not expose undeclared sibling
operations from the same facet.

`RequestExecutionScope.bindDevice(device, use)` is the trust choke point. It:

1. resolves the exact local or provider runtime owner;
2. checks every required operation and classifies each preferred operation against facts for the
   platform leaf, device kind/backend, and provider mode;
3. creates or reuses one request binding for that ownership-qualified device;
4. verifies that every required operation and every preferred operation advertised as available has
   a concrete facet implementation; an advertised operation with no implementation is a
   runtime-contract error; and
5. returns a selected operation projection: required operations are non-optional, declared preferred
   operations are optional and present only when available, and undeclared operations are inaccessible.

The cached broad runtime remains private to `RequestExecutionScope`; narrowing does not intersect a
wide optional aggregate that would still expose undeclared facets. The descriptor and its specialized
handler share one non-widened declaration, and a widened generic descriptor carries no static proof.
A compile-time contract test proves the selected projection. A structural
**runtime-facet-narrowing gate** covers every runtime-migrated handler owner and rejects attempts to
manufacture required-operation proof with assertions or optional admission. Optional access is
permitted only for descriptor-declared preferred operations. The tracking issue owns the gate
implementation and its required planted violation.

Absence or failure of a preferred path may change optimization/path disclosure, not whether the
semantic command can execute. Failure falls back to the complete required path only through a typed
reason and an explicit descriptor/ADR 0011 path classification; it is never a generic `catch`
fallback. Helper/session reuse hidden inside one required operation remains that facet's implementation
detail and follows ADR 0002 rather than becoming a daemon-visible preferred operation.

Family registration and support coverage are separate gates. The immutable registry owns each of the
six canonical families exactly once. Before a command cuts over, an independent parity artifact
freezes its legacy supported/unsupported cells and hints. Runtime-fact scenarios expand canonical
kernel-owned family/leaf fixtures over device kinds/backends and provider modes; a new runtime may
not make a difficult legacy-supported cell disappear. Behavior changes require a separate decision.

Apple coverage uses an exhaustive `AppleOS` fixture table and explicitly exercises iOS simulator and
physical backends where they differ, iPadOS, tvOS focus-only/no-coordinate behavior, macOS desktop,
visionOS deferred or supported cells, and the watchOS unsupported/discovery-absence sentinel. Every
fixture matches exactly one family. A loop over six families with one generic `platform: 'apple'`
device is not leaf coverage.

### 3. Provider ownership is exact and fail-closed

For one device, provider resolution has three outcomes:

1. exactly one provider owns it: bind that provider-owned runtime;
2. no provider owns it: bind the local family runtime; or
3. more than one provider owns it: fail with an ownership-contract error.

Only providers that declare device-runtime ownership participate in this arbitration. A narrow tool,
transport, app-log, or recording provider is an injected dependency of the selected local/provider
runtime; it does not become a second runtime owner or compete in the owner count.

Provider ownership is authoritative. If the owning provider lacks a required fact or facet, admission
returns the typed unsupported result; it never tries the local family implementation. A provider may
implement a complete runtime directly, as Cloud WebDriver can, or contribute a narrow transport used
inside the owning family module, as an Android transport can. Provider callback stacks threaded
through daemon handlers are not part of the new seam.

Ordinary binding performs the arbitration above. Every `DeviceBinding` also exposes a unique,
restart-stable runtime-owner reference identifying the local family owner or the configured provider
runtime instance, not merely a provider kind. Composition rejects duplicate owner references. Durable
descriptors embed that reference; exact-owner binding resolves it directly, validates descriptor
device/fence identity, and never reruns ordinary ownership arbitration or `ownsDevice`. An unavailable
expected provider is `unreattachable: owner-unavailable`; it never becomes a local bind.

### 4. Bindings attach to process-lived helper managers; they do not own helpers

Platform gateways and their helper managers are process-lived. Individual helper generations remain
lazy, identity-bound, invalidatable, restartable, and idle-stoppable under ADR 0002. A request binding
attaches cancellation, diagnostics, progress, and admitted device/session context. Disposing it
releases only those request attachments and request-local acquisitions.

The underlying `DeviceBinding` implements `AsyncDisposable` and remains private to
`RequestExecutionScope`; handlers receive only a non-disposable `BoundDeviceRuntime<Use>` projection.
Each gateway bind owns a private rollback stack and publishes a binding only after every request-local
acquisition succeeds. Failure after any internal acquisition releases that partial state before the
bind rejects. On publication, ownership transfers exactly once to a repository-owned, reverse-order
scope disposal stack; caching another projection never registers or disposes the binding twice.

Request execution invokes that stack from `finally`. Source-executed TypeScript does not use
`await using` while the supported minimum Node 22 runtime cannot parse that syntax, type stripping
cannot lower it, and Node 22 has no `AsyncDisposableStack`; the contract keeps a later syntax migration
mechanical. A binding itself is never adopted beyond the request; only a durable resource handle
returned by one of its facets may transfer to session ownership.

Persistent helper shutdown happens only through explicit device lifecycle policy, helper-manager
invalidation, platform idle policy, or platform-module shutdown after daemon-session resources have
been finalized. After adoption, a durable handle may retain its own helper attachment beyond the
originating request; that attachment belongs to the handle and is no longer registered for
request-scope disposal. Adoption detaches every originating request diagnostic/event/progress port.
Later `finish` or forced disposal executes inside the current request observability scope or an
explicit daemon session-teardown observability scope; a durable handle never retains an old request
async context.

A shared lifecycle contract scenario is required for every helper-backed runtime. With idle expiry
disabled and no invalidation, process exit, identity change, or ownership transfer, it proves that
disposing request bindings never terminates or restarts the healthy helper and an immediate later
binding reuses that generation. Module shutdown terminates each still-live, still-owned generation at
most once. Every durable-resource facet separately proves that its adopted resource survives
originating-binding disposal. Each platform supplies honest evidence appropriate to its helper rather
than relying on wall-clock behavior alone. Bind contract scenarios also fail after each successive
internal acquisition and prove that the unpublished partial binding leaves no request attachment.

Published bindings are disposed on success, failure, cancellation, and early return, in reverse
acquisition order; unpublished partial binds roll themselves back before rejecting. Disposal runs
inside the active request diagnostics/event context before `request.finished`, diagnostics flush,
final response construction, and device/session lock release, so cleanup-only failure cannot follow a
recorded success. If the operation and cleanup both fail, the operation error remains primary and
cleanup is structured secondary diagnostic evidence; a cleanup-only failure surfaces normally.

### 5. Durable resources are reattachable by the same owner

App-log streams, screen recordings, and native profiler captures may outlive one request. Starting
durable work returns:

- a **live resource handle**, which is process-local authority to finish or forcibly dispose the
  active resource; and
- a **durable resource descriptor**, which is bounded, JSON-safe, versioned state sufficient for the
  exact runtime owner to make a deterministic recovery attempt.

Facet-specific handles expose `finish(): Promise<FinishOutcome>` for idempotent normal completion,
`forceCleanup(): Promise<CleanupOutcome>` for outcome-bearing forced cleanup, and idempotent
`[Symbol.asyncDispose](): Promise<void>` as the scope-cleanup adapter. The adapter resolves only for
confirmed cleanup/already-missing outcomes and rejects with a normalized ownership-lost or
cleanup-pending error otherwise; it does not pretend `Promise<void>` carries a typed result.

Every destructive finish/cleanup operation holds the authoritative ownership lease from fence
validation through the native side effect and persisted lifecycle transition, or passes a fencing
token to a native/provider operation that atomically rejects stale owners. A check immediately before
the side effect is not sufficient. A transport that can provide neither mechanism cannot claim
transferable reattachment; cleanup-only recovery requires proof that the prior owner is gone, and
otherwise remains manual recovery.

A facet start internally rolls back if it cannot publish a complete handle/descriptor pair, and the
start promise is invoked through the request scope's pending-transfer guard. The scope registers the
guarded handle for forced cleanup before resolving the result to command orchestration, then releases
that guard only after the authoritative active record and the live `SessionState` handle/descriptor
adoption both succeed. Cancellation or failure anywhere in that gap disposes the unadopted handle and
terminalizes the record only after confirmed cleanup; uncertain cleanup leaves the record
cleanup-pending. Contract scenarios inject cancellation and failure between partial start,
publication, persistence, live adoption, and transfer.

There is no generic `PlatformResource`. Live `SessionState` may retain a neutral facet-specific
contract handle beside its descriptor and metadata; the field has one R7 transition owner. Only the
descriptor and neutral metadata enter the authoritative persisted recovery record. Concrete platform
classes, provider clients, child handles, timers, transports, and wait promises enter neither store.

The daemon shares the lifecycle mechanics of those facet-specific resources through one
`DurableCaptureResource` coordinator. It owns bounded manifest I/O, per-resource fence serialization,
start/persist/adopt compensation, terminal transitions, and deadline-bounded exact-owner recovery.
The coordinator receives a facet's resource kind and manifest store, neutral session slot, completion
metadata projection, failure wording, and exact-owner recovery adapter; it does not select platforms,
interpret command flags, or form a generic runtime facet. App-log and screen recording retain distinct handles,
descriptors, facts, native finalization semantics, and admission policy. Reusable codec/live-handle
mechanics below the daemon remain in `@agent-device/capture-kit`, preserving the package direction.

A daemon-owned, process-lifetime admission ledger may retain bounded cleanup uncertainty that has no
honest durable representation, but it is not a second live-resource store: it contains no handle or
descriptor, never supersedes the persisted manifest, and is keyed by canonical device identity when
that identity is known. Evidence that can be checked again, such as a retained legacy marker path, is
revalidated at admission so manual recovery can unblock the matching device without a daemon restart.
Unknown-identity evidence remains globally fail-closed, while undurable in-memory blocks expire only
under an explicit bounded policy with diagnostics.

Persisted JSON re-enters as `unknown`. Contracts first validate a neutral envelope containing resource
kind/envelope version, session/device identity, exact owner reference, fence, and lifecycle state.
Only after exact-owner selection does that facet's total codec decode its descriptor body. Invalid or
unknown envelopes/bodies remain retained recovery evidence with a typed
`descriptor-invalid`/`descriptor-version-unsupported` outcome; they are never cast to a descriptor,
deleted, or offered to another facet.

When no live handle is available, the daemon completes lease/admission and takeover fencing, binds
the descriptor's exact owner, and calls that facet's typed `reattach`. Reattachment returns a closed
outcome: `active` with a handle, `completed` with its result, `missing`, or `unreattachable` with a
typed reason. Unsupported descriptor schema/version returns
`unreattachable: descriptor-version-unsupported`: the facet does not guess a migration, discard the
descriptor, fall through to another owner, or start a replacement. Other closed reasons include
`owner-unavailable`, `transport-not-reattachable`, and `ownership-fence-lost`. A descriptor may
explicitly declare cleanup-only recovery when its native transport cannot reconstruct equivalent live
control; that limitation is a runtime fact, not a best-effort guess during takeover.

Reattachment does not rehydrate `SessionState` or change `SESSION_NOT_FOUND` policy. With no admitted
live session, a reconstructed handle is recovery-scope-owned and may only complete or clean up the
resource; adopting it for continued session use requires an independently admitted live session.

Every durable facet also exposes a typed, idempotent
`cleanup(descriptor, fence, scope): Promise<CleanupOutcome>` for descriptor-only forced cleanup.
Cleanup-only recovery uses this operation instead of pretending to reconstruct a full handle, and its
closed outcome records cleaned, already missing, or still cleanup-pending state. Finish, dispose, and
descriptor cleanup all use the same serialized/atomically enforced fence. If the exact owner or
descriptor schema is unavailable, cleanup cannot be guessed: the authoritative record remains
cleanup-pending with a manual-recovery reason.

The descriptor must have an authoritative persisted home before command start success is returned.
Prefer the platform/resource-owned recovery manifest when that resource already owns one. If a
resource has no honest manifest, introduce a daemon-owned persisted resource record only for that
demonstrated need, and extract a shared resource index only after multiple resource types earn it.
Current diagnostics/session events—and any future journal from proposed ADR 0018—are
observability-only and never a recovery source of truth. They may mirror descriptor lifecycle events,
but reattachment never scans telemetry to rebuild state.

Every authoritative home exposes a deterministic facet-owned lookup or enumeration path after
process loss. Its neutral record carries session/device identity, the exact runtime-owner reference,
descriptor and metadata, an ownership/fence token, and one of two persisted lifecycle states:
`open` or `completed`. In-progress distinctions such as starting, active, completing, and
cleanup-pending are phase metadata on the open record, not additional lifecycle states. The fence and
the descriptor remain authoritative across every open phase; cleanup uncertainty therefore cannot be
encoded as a terminal lifecycle. A new handle is not exposed until the persisted ownership fence is
acquired. Every finish/cleanup attempt holds that ownership guard through destructive work and the
persisted transition, or delegates to an operation that atomically enforces the token, so a prior
owner cannot later terminate a transferred resource.

Persisting a descriptor does not make external-resource start and descriptor write atomic. A
platform whose native tool cannot close that crash window retains a platform-owned orphan marker or
equivalent recovery protocol. Descriptors contain stable reconstruction coordinates, not promises,
timers, child handles, buffers, credentials, or a dump of live implementation state.

Ownership transfer is explicit. Start persists active recovery evidence before returning command
success, and the pending guard transfers only after live session adoption. Completion preserves a
terminal result or stable result coordinates before active recovery evidence is removed. Once
adopted, request-binding disposal cannot stop the resource. Normal session teardown preserves
facet-specific ordering; adopted durable handles are not placed in the request binding's generic
disposable transaction.

### 6. Command cutover is the abandonment-safe migration unit

The command descriptor is the sole migration discriminant, but it does not own a daemon handler
value. It declares command identity and an internal-only execution mode excluded from public
projections. The mode selects one neutral declaration shape: `none`, legacy platform admission,
device `runtimeUse`, or `inventoryUse`. The `none` mode (amendment, 2026-08-11) is the explicit
declaration that a command executes no platform behavior: a `none` descriptor never binds a device,
carries no capability bucket, owns no platform adapter, and declares no runtime or inventory use;
lease, session-management, and daemon-management commands are `none`. The mode is declared
explicitly on every descriptor — a registry-entry default that silently assigns a mode cannot
distinguish a command with no platform execution from an unmigrated one and is prohibited. ADR
0003's daemon-owned total route table continues to own specialized
handler implementations and request-policy traits; that route/policy projection remains present and
unchanged in every mode. A derived coherence gate joins the declarations without importing daemon
handlers into the descriptor registry.

The descriptor-derived **runtime-command-cutover gate** applies to platform-executing descriptors
only; `none` descriptors are outside its denominator, and the gate separately rejects a `none`
declaration on any descriptor that binds devices, keeps a capability bucket, or reaches platform
behavior. For a platform-executing descriptor it covers the command's whole platform-execution
projection: either legacy admission/hints plus its complete legacy platform adapter; device runtime
use plus fact-derived admission and its complete runtime-backed adapter; or inventory use plus the
composed inventory gateway. Never more than one and never none. A migrated device unit deletes its old
capability closures/hints and legacy platform adapter. A migrated inventory unit deletes its old
inventory branches/adapter. Neither cutover deletes, duplicates, or changes the ADR 0003 daemon route.
No handler selects old versus new platform behavior by family, provider, failure, environment
variable, or feature flag.

One device-command migration unit is one command across every runtime cell where it is currently
supported: all applicable platform leaves, device kinds/backends, transport-composed providers, and
direct provider runtimes. Unsupported cells are classified through new runtime facts; they do not
remain on the old adapter. An inventory-command unit covers every local family and provider inventory
source plus selector/public projection parity. The unit also deletes that command's superseded daemon
platform branches, backend tags and tag-to-implementation maps, capability closures/hints, legacy
imports, parity scaffolding, and old platform adapter. The independent pre-cutover parity artifact
proves available-command and unsupported-hint equivalence before those legacy sources are deleted; a
deliberate behavior change is a separate decision rather than a migration gap.

Facets organize contracts and implementation locality; a whole facet is not a required PR boundary.
A repository may indefinitely contain migrated and unmigrated commands, but no command has two
platform-execution paths and no merged state depends on a later PR for correctness. Rollback is a
revert of the complete command unit, not a retained execution fallback.

A behavior-neutral package/registry substrate may land before the first command only when it routes
no production descriptor, is dead-code clean, independently revertible, and preserves lazy loading.
Otherwise it lands with the `devices` command unit. Shared Apple-runner or Android-helper mechanics
used by migrated and legacy commands are not duplicated or connected through a package-to-root
back-import. They either remain physically in place until their last consumer can move, or move
behind a neutral lower-level capability injected by composition into both the package facet and the
complete legacy adapter while command execution ownership remains singular.

The substrate and every command unit are reviewed from a clean committed tree with all production
files present in `HEAD`; a green layering run while new production files are untracked is not
evidence. Platform packages receive no migration allowlist or root back-import exception.
`check:affected` must select platform contract, provider, and coverage scenarios for a
`packages/platform-*` change. Every new structural gate is accepted only after a planted violation
demonstrates the intended red result.

Any unit touching `SessionState` classifies each changed field once under R7, keeps request bindings,
concrete platform/provider types, and raw process/transport mechanics out, and gives each mutable
resource field one transition owner. The permitted live value is the opaque implementation behind a
neutral facet-specific handle contract. The unit proves partial-start cleanup, transfer, finish,
forced disposal, and error precedence. Equality-pinned R10 writer/owner counts and external
`daemon/types.ts` importer membership are lowered in the same unit when they shrink. R9 total-cycle
and R10 cycle-zone pressure may not grow; shrink reporting follows their existing growth-only policy.

### 7. Adoption checkpoint

No command migration beyond the metadata/package substrate and complete `devices`, `logs`, and
`network` command cutovers begins until this ADR's Status records **continue**. `network` is included
because it consumes the app-log resource. Daemon-owned generic session teardown may invoke the
neutral app-log handle's forced-disposal contract without changing `close`'s legacy platform adapter;
the `logs` unit proves that path through `close`. If `close`, `open`, or another command instead must
bind a runtime or select app-log platform behavior, its full unit must be named in Status before the
substrate lands. `logs` is the deliberate first descriptor/reattachment pilot, not merely a
request-lifetime handle exercise.

Before the substrate lands, the tracking issue records and reviews the exact commands, thresholds,
scenario denominator, and scoped counts used below. The same measures are reported from the clean
committed checkpoint tree.

The checkpoint records exactly one outcome:

- **continue**: every hard evidence item passes and broader command migration may proceed;
- **revise**: amend the contracts/ADR, rerun the checkpoint, and begin no further command migration; or
- **stop**: abandon broader migration; already-landed command units remain coherent or are retired by
  a separate explicit decision.

Any failed hard item requires **revise** or **stop**; recording evidence of the failure is not
evidence for **continue**.

Evidence must cover:

- one platform-execution path, an unchanged ADR 0003 route/policy projection, and zero old capability
  closures, tags/maps, or concrete daemon platform imports for each migrated command;
- package direction and the absence of daemon request/session/command types in platform packages;
- independent package builds/declarations, metadata-eager/implementation-lazy loading, and reviewed
  startup/build/package thresholds;
- typed runtime-use narrowing and a planted-red narrowing-gate violation;
- six-family runtime ownership, six local inventory sources, provider inventory sources, and
  independently enumerated leaf/device/provider support parity and scenario counts;
- provider-first fail-closed behavior plus unique restart-stable exact-owner references;
- rollback after every partial bind acquisition and published-binding disposal without
  persistent-helper shutdown;
- descriptor persistence and exact-owner recovery after loss of a process-local handle, including
  validated decoding, resumed control for reattachable cells, executable descriptor-only cleanup,
  and explicit cleanup-only/version-unreattachable behavior;
- pending-handle cleanup across every start/persist/adopt/transfer gap, durable-handle transfer,
  serialized or native-atomic fencing, idempotent teardown, and operation/cleanup error precedence;
- semantic/provider/device parity for `devices`, `logs`, and `network`;
- unchanged-or-lower R7/R10, type-cycle, and external-daemon-type ratchets; and
- numeric before/after daemon platform import, branch, and tag counts with a strict net decrease.

The seam is revised or stopped before broader migration if a platform package needs root/daemon or
sibling-platform imports; a command needs old/new or provider/local execution fallback; runtime
facets degenerate into tags, command switches, or opaque execution payloads; leaf/provider facts
require default fallthrough; `SessionState` names/exposes concrete platform/provider types or raw
mechanics rather than the permitted neutral live handle; a persisted record bypasses the validated
neutral envelope or facet-owned descriptor codec, or contains raw live mechanics; implementation
laziness cannot be preserved; R7/R10/type-cycle pressure grows; or the landed slices add more daemon
platform ownership than they remove.

#### Checkpoint result: continue under the revised cumulative budget (2026-08-10)

The final checkpoint compares `44c298d7f3a0ef84bc47f34c54d88b6c9eeb0df2` with stack head
`457fafe6399a95a4ddbfac57f02b3a7fe4157a54` on the same host and toolchain. Merged `devices`
`c06bed9f773a27ae0a02cb012570def2f2d0b90e` is part of that range; rebasing the remaining PRs onto it
does not reset the denominator. The earlier `99f5af1b7` checkpoint missed a stale owned-marker wedge,
Apple scoped-provider bypass, Android optional-recovery loss, and absolute network line-number
regression. The later cleanup review found a cross-device retained-marker wedge, a manual-recovery
hint that remained blocked until daemon restart, and an Android app-log stream that stayed pinned to
the pre-relaunch app PID. Each correction was observed red before its focused test passed; the final
admission test proves removal of the matching retained marker permits a second start in the same
daemon process. On exact final logs head `188795386`, a controlled Android relaunch moved the app from
PID 10952 to 11455, rotated the durable logcat marker to PID 11455, and retained both before/after
canaries plus the new process output in one `app.log`. Guarded daemon/dead-child recovery separately
terminalized the manifest and allowed a clean second start.

The required revision package is complete:

- `@agent-device/capture-kit` is the private durable-capture implementation package. Contracts keeps
  pure runtime types and plan models; capture-kit owns process/recovery/live-handle mechanics,
  envelope/descriptor codecs, and network parsers. The dependency order is
  `kernel < contracts < capture-kit < platform/provider/daemon`. A planted-red gate rejects process,
  filesystem, or timer mechanics drifting into contracts. The package is wired into affected-check
  selection, the layering test enumeration, and the workspace typecheck project list.
- Canonical kernel device identity replaces the duplicate encoders while facts-shape validation stays
  separate. The bounded Android/Harmony PID owner factory lives in capture-kit; Apple and Limrun stay
  custom, there is no network factory, and all loaders retain their lazy boundary. The managed-command
  allowlist, unused façade exports, public Limrun runtime-module declaration leak, quadratic JSON walk,
  and duplicate lifecycle/reconnect mechanics are gone. The temporary Android implementation files
  introduced by the devices PR are also absent from contracts at this checkpoint.
- Plan-declared app-session requirements replace repeated handler guards. Persisted durable lifecycle
  is `open | completed`, with transient phase retained as metadata. A daemon-owned admission ledger
  scopes decodable evidence by device identity, rechecks manually removed legacy markers, bounds
  undurable blocks, and remains subordinate to the durable manifest. Discriminated teardown settles
  app-log state, re-reads the replaced session record, then runs generic teardown, avoiding the stale
  reference and double-cleanup path.

The final gates passed:

- `pnpm check:affected --run` at `457fafe63` passed 799 test files / 6,424 tests with 2,097/2,401
  changed executable lines covered (87.34%), plus format, lint, typecheck, build/declarations,
  published-package clean install, fallow, provider integration, replay compatibility, and
  integration-progress checks.
- `pnpm check:layering` passed 131 structural/model tests and scanned 1,157 production source files.
  R11 owns 17 workspace packages behind 39 exported subpaths with no root back-imports; R13 keeps six
  private implementation-lazy platform packages above capture-kit behind one composition root; R14
  and R15 retain one typed route for `logs` and `network` with no legacy route.
- Six local inventory/runtime owners, all enumerated Apple leaf/kind cells, and the production
  BrowserStack, AWS Device Farm, and Limrun provider modes remain covered. Provider ownership and
  inventory are fail-closed; exact-owner recovery and provider-authoritative tests prove there is no
  provider-to-local fallback. Durable tests cover every start/persist/adopt gap, exact-owner recovery,
  cleanup-only and descriptor-only cleanup, fencing, idempotence, and primary-error precedence.
- R7/R10 remain at 23 writer-owned `SessionState` fields and 29 owner claims, with all 34 fields
  classified. The largest type cycle is 46 against the 47-file ceiling, and the two external
  production `daemon/types.ts` importers are unchanged. Checkpoint-owned `logs`/`network` platform
  decision lines remain zero.

Issue 1704 revised the budget for this checkpoint for three explicit reasons: capture-pipeline
reliability through fenced ownership and exact recovery, durable cloud log streaming that did not
exist in the baseline, and a reusable durable-capture substrate. This is not a new observability
layer: the CLI-observable `logs` behavior remains parity work. The budget stays cumulative from
`44c298d7f`; the exact clean post-revision measurement is the reviewed upper bound for this checkpoint,
not a reusable allowance for future units:

| Metric             | Original baseline | Revised cumulative bound / checkpoint |              Change |
| ------------------ | ----------------: | ------------------------------------: | ------------------: |
| Raw JavaScript     |       2,036,067 B |                           2,131,689 B | +95,622 B (+4.696%) |
| Gzipped JavaScript |         659,646 B |                             695,134 B | +35,488 B (+5.380%) |
| npm tarball        |         797,027 B |                             826,761 B | +29,734 B (+3.731%) |
| npm unpacked       |       2,781,186 B |                           2,878,492 B | +97,306 B (+3.499%) |

The controlled 15-run startup medians showed no regression (`--version` 94.5 ms to 47.4 ms;
`--help` 91.2 ms to 72.0 ms). Module-level source-map inspection found no duplicate implementation
emission; the distribution cost is the accepted reliability/cloud/substrate decision above. Future
units must define and review their own cumulative budget rather than inheriting this headroom.

The recordings command unit has its own reviewed budget (2026-08-11). The cumulative denominator
remains the original `44c298d7f` baseline; rebasing onto the completed checkpoint does not reset it.
The immediate stack-base delta from durable-capture head `e3b0956b` is reported separately so the
cost of this command unit stays visible. The exact #1724 head that reproduces this table is recorded
in the acceptance comment before readiness. The increase pays for runtime-owned screen-recording
transports, fenced artifact finalization and cross-daemon recovery, and provider parity. It is not
unused checkpoint headroom and is not an allowance for a later command:

| Metric             | Original baseline | Recording bound |    Cumulative change | Recording-only change |
| ------------------ | ----------------: | --------------: | -------------------: | --------------------: |
| Raw JavaScript     |       2,036,067 B |     2,166,159 B | +130,092 B (+6.389%) |   +32,026 B (+1.501%) |
| Gzipped JavaScript |         659,646 B |       708,776 B |  +49,130 B (+7.448%) |   +12,902 B (+1.854%) |
| npm tarball        |         797,027 B |       836,426 B |  +39,399 B (+4.943%) |    +8,987 B (+1.086%) |
| npm unpacked       |       2,781,186 B |     2,913,430 B | +132,244 B (+4.755%) |   +32,494 B (+1.128%) |

These bounds admit only the completed recordings cutover. Every subsequent command unit must define
and review both its original-baseline cumulative bound and its immediate stack-base delta.

The tracking issue owns command order, PR/file lists, test-only compatibility fixtures, exact
benchmark commands and thresholds, raw evidence, and reviewers. Temporary fixtures never authorize
a production bridge, duplicate route, or recorded package back-import. After the checkpoint, this
ADR's status records its outcome; it does not retain a migration diary.

### 8. Broader migration is move-dominated and evidence-tiered

The checkpoint and recordings budgets paid for machinery that later units reuse; they are not a
precedent for growth. Every post-checkpoint unit still defines its original-baseline cumulative
bound and immediate stack-base delta, but the default expectation inverts: a unit relocates
existing platform mechanics from root `src/` into platform packages and deletes superseded daemon
code, so its shipped-size delta trends to zero or negative. The unit's review reports root bytes
removed against package bytes added; net growth is exceptional and each contributing addition is
named and justified individually. Contract modules stay vocabulary-thin under the existing
capture-kit rule; per-unit type inflation is size growth and is reviewed as such.

A command surface that is deprecated and scheduled for removal at the next major is never
migrated. It stays on its legacy execution shape until the major deletes it, and the deletion — not
a migration — retires its platform coupling. Where a command's public surface is being narrowed,
the narrowing merges first so the migration denominator is the surviving surface only.

Evidence requirements follow what a unit imports, in two tiers. A **request-scoped device unit**
uses facts and operations only: its evidence is the typed use declaration, fact coverage for every
denominator cell, the enumerated legacy-parity cell table recorded in the unit review, and the
cutover gate. It must not import admission ledgers, fences, durable descriptors, or recovery
adapters, and their evidence items do not apply to it. A **durable-resource unit** additionally
carries the full section 4–5 lifecycle evidence. The tier is declared in the unit review; importing
durable machinery promotes the unit to the durable tier.

The per-command cutover gates consolidate into one parametrized runtime-command-cutover gate driven
by a table of migrated commands. Adding a unit adds a row; the parametrized gate carries one
planted-red violation for the mechanism, not one per row. The four existing per-command policy
files fold into it in the first post-amendment unit that would otherwise add a fifth.

Facts are the only support authority for a migrated command. The unit deletes the command's
descriptor capability bucket and its `requireCommandSupported` wiring together with the legacy
adapter; retaining both is a dual admission path and fails the cutover gate.

### 9. Binding ergonomics: one bind per handler

The gateway exposes side-effect-free facts inspection for an ownership-resolved device. It answers
admission, `capabilities`, and doctor questions without creating a request binding, acquiring
helpers, or touching the device; it shares the owner's lazy loading. A handler binds exactly once,
with the execution use its plan selected. The admission-use idiom — binding with an empty required
set to read facts — is retired for new units: they may not introduce admission-only binds. Moving
an already-migrated handler onto facts inspection changes production admission behavior; it is its
own independently reviewed unit with parity evidence, never a side effect of a structural change.

Use declarations share one neutral `defineUse`; per-domain currying wrappers add a module per
domain for no information and are not added. Required-only declarations are the default. Declaring
a preferred operation requires a recorded measurement of the fast path's benefit in the unit
review; the direct-selector fast path is the model. A preferred operation declared without a
measurement is speculative surface and is rejected in review.

### 10. Process-lifetime and cross-cutting surfaces

A cross-cutting facet — one consumed from more than one command's execution path, such as snapshot
freshness, the system-chrome guard, presentation rules, or runtime hints — lands inside the first
command unit that consumes it and is named in that unit's review. Its contract has one owner. Later
units consume the existing facet; forking a parallel contract for the same concern is a seam
violation. A facet PR with no consuming command remains prohibited under section 6.

Daemon startup gains no per-platform entrypoints. Startup recovery is evidence-gated: persisted
durable manifests and platform-owned markers are the only triggers, and a family's mechanics load
only when its evidence exists — preserving implementation laziness because an evidence-free family
is never evaluated. The app-log recovery path is the model. Remaining platform-specific startup
recovery (the Android test-IME marker, web browser orphans) moves onto this pattern when its owning
domain migrates, not before.

Daemon shutdown is two-phase through the gateway. The detach phase runs before daemon session
teardown and offers each process-lived helper manager its handoff policy — a healthy kept-hot
helper may transfer to a successor daemon rather than stop. The stop phase runs after session
resources are finalized and terminates each still-owned generation at most once, per section 4.
Platform-specific shutdown calls in the daemon runtime are deleted as their owners migrate onto the
phases.

Session teardown keeps its isolated-step skeleton and gains no generic hook API. Each remaining
platform-specific step belongs to a domain and is deleted by that domain's unit: perf steps by the
perf unit, test-IME restoration by the input domain as durable device state with marker-based
recovery, helper stops by the owning platform module's device-lifecycle policy, close-time alert
dismissal by the close unit. A teardown step that survives its domain's cutover is a migration gap.

As a daemon area loses its last platform import, the same unit narrows the R3 platforms-seam
allowlist to match; the seam list may never grow. Seam removal alone is not the end-state
enforcement: R3 tolerates dynamic and type-only platform imports, and legacy daemon behavior
reaches platforms through exactly those edges. The end state is a dedicated planted-red rule
rejecting every dependency edge — static, dynamic, re-export, and type-only — from production
`src/daemon/**` modules (test files excluded, matching the layering scanner's scope) to
`src/platforms/**` and to concrete `@agent-device/platform-*` packages; daemon types come from
contracts only. Once that rule is green with `src/daemon/` removed from the seam, daemon
platform-freedom is structurally enforced rather than measured.

## Relationship to prior decisions

- [ADR 0001](0001-provider-first-integration-scenarios.md): provider-first scenario coverage and
  semantic provider operations remain. The monolithic `Interactor` and request callback-stack
  topology are superseded as commands migrate.
- [ADR 0002](0002-persistent-platform-helper-sessions.md): persistent-helper protocols,
  invalidation, and explicitly safe one-shot fallback remain. Daemon ownership means lifetime
  policy; platform modules own helper managers/mechanics, and request bindings never own helpers.
- [ADR 0003](0003-daemon-command-registry.md) and
  [ADR 0007](0007-remote-device-leases.md): daemon request-policy traits, lease admission, and lock
  ordering remain daemon-owned. Binding happens only after their admission requirements are met.
- [ADR 0008](0008-command-descriptor-registry.md): the descriptor registry remains the command root.
  Device-command capability buckets evolve into typed required/preferred runtime use joined with
  exact runtime facts; inventory commands declare inventory use.
- [ADR 0009](0009-apple-platform-consolidation.md): the Apple family and `AppleOS` leaf axis remain.
  The shallow `PlatformPlugin` shape is superseded as command units migrate; physical shared
  mechanics move only through the legal injected substrate transition or after their last legacy
  consumer.
- [ADR 0010](0010-error-system.md): normalized errors remain; this ADR adds operation/cleanup
  precedence and typed reattachment outcomes.
- [ADR 0011](0011-interaction-guarantee-contract.md),
  [ADR 0013](0013-unified-gesture-plans.md), and
  [ADR 0014](0014-session-ref-frame-lifetime.md): interaction paths stay distinct, normalized gesture
  plans cross the seam, and daemon authorization expires immediately before any possibly mutating
  facet call. Platform implementations may not hide UI mutation inside an observational facet.
- [ADR 0018](0018-unified-event-journal.md) is proposed, not a dependency of this decision. If
  accepted, its journal and teardown scopes may implement this ADR's observability contexts, while
  remaining observation rather than coordination or persisted recovery state.

## Consequences

The daemon keeps policy, command semantics, response construction, session/lease ownership,
selector/ref authority, interaction guarantees, and artifact orchestration. Platform packages gain
locality for native mechanics, provider transport composition, persistent helpers, and resource
recovery. Adding a platform implements existing runtime contracts and facts instead of adding daemon
tags, maps, callbacks, and branches.

The cost is a staged cross-repository migration with temporarily coexisting legacy,
inventory-backed, and device-runtime-backed commands. Command-atomic cutover, explicit deletion
boundaries, and the early adoption checkpoint keep that coexistence shippable and abandonment-safe.

## Alternatives considered

- **Move all platform source into packages first:** rejected. It changes physical ownership before
  proving the behavior seam, creates large root-import tunnels, and cannot be reviewed or abandoned
  command by command.
- **Keep extending `PlatformPlugin` with tags and predicates:** rejected. It relocates selection data
  but leaves the daemon mapping every platform tag back to behavior.
- **One replacement `Interactor`, universal dispatcher, or `SystemFacet`:** rejected. Platform leaf
  support differs by operation, and a wide optional interface recreates unsupported stubs and
  command-aware platform code.
- **Provider/local or old/new execution fallback:** rejected. Provider ownership and command cutover
  must be exact; success-path fallback hides semantic divergence. Explicitly accepted internal helper
  fallbacks remain governed by ADR 0002.
- **Use session events or a future event journal as the durable-resource store:** rejected. It would
  make correctness depend on observability; current events are projections, and proposed ADR 0018
  explicitly preserves the same no-state-from-events rule.
- **A separate process-local resource ledger beside `SessionState` for live handles:** rejected. The
  session store is in-memory, so live `SessionState` already is the process-local home; a parallel
  handle/descriptor store would duplicate the ownership its R7 transition owner governs. The accepted
  admission ledger is narrower: it holds only bounded cleanup-block evidence, contains no live handle
  or descriptor, and never replaces the authoritative manifest.
- **Rely only on performance thresholds for lazy loading:** rejected. Thresholds catch regressions
  late and can pass while unrelated implementation graphs load; the import/evaluation shape is also
  contract-tested.
