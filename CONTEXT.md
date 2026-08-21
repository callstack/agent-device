# Agent Device Domain Language

Canonical vocabulary for the automation domain. Use these names in code, tests, issues, and
architecture notes; implementation decisions and procedures belong in ADRs and task guidance.

## Language

### Sessions, targets, and devices

**Platform family**:
An internal ownership group for related automation platforms: Apple, Android, HarmonyOS, Vega,
Linux, or web.

**Platform leaf**:
A concrete OS and device shape within a platform family whose support is classified independently,
such as iOS simulator, physical iOS, tvOS, or macOS.

**Platform module**:
A private package that owns one platform family's device mechanics and exposes its metadata and
runtime bindings.

**Device inventory gateway**:
The platform-neutral composition of local-family and provider inventory sources.

**Device runtime gateway**:
The platform-neutral boundary that reports runtime facts and binds an admitted device to its
runtime owner.

**Runtime owner**:
The one local platform module or provider runtime selected to execute behavior for an
ownership-qualified device.

**Request binding**:
A request-lived attachment of cancellation, diagnostics, progress, and admitted context to a
runtime owner.

**Bound device runtime**:
The behavior-bearing view returned after a request binding proves the required runtime operations.

**Runtime facet**:
A capability-cohesive interface on a bound device runtime with semantic inputs and typed outcomes.

**Runtime fact**:
A typed claim about behavior available for one exact platform leaf, device or backend, and provider
mode.

**Narrowed bound runtime**:
A projection that exposes required facets, optional preferred facets, and no undeclared facets.

**Host capability**:
Narrow authority supplied to a platform module for host execution, diagnostics, progress, or native
assets.

**Target**:
The selected automation destination, such as mobile, TV, or desktop.

**Session**:
Daemon-owned state for one selected target and its opened app or surface.

**Device key**:
A stable provider-scoped identity used for device ownership and contention.

**Device lease**:
Logical remote ownership of a selected device for a tenant, run, or client.

**Lease provider**:
The remote connection source that routes and owns a device lease.

**Runner lease**:
A mutual-exclusion guard for a platform helper process. It is not remote client ownership.
_Avoid_: Device lease, process lease

**Device claim**:
Host-global exclusive ownership of one local device by an open session or a sessionless mutating
command.

**Device-claim policy**:
A command's declared relationship to local device ownership, including observation, acquisition,
release, and exclusive mutation.

### Commands and routing

**Command surface**:
The catalog of public command identity, interface exposure, adapter policy, and shared metadata
across CLI, Node.js, MCP, and batch entrypoints.

**Runtime use**:
A command's platform-neutral declaration of operations required for admission and preferred fast
paths whose absence does not reject the command.

**Inventory use**:
An inventory command's platform-neutral declaration for composing device sources without binding a
selected device.

**Daemon command registry**:
The daemon-side source of truth for route ownership and request-policy traits.

**Runner command traits**:
Per-command classifications that control Apple runner lifecycle and recovery behavior independently
of the public command surface.

**Daemon RPC protocol version**:
The integer used to detect breaking compatibility across the remote daemon boundary.

**Version-skew invariant**:
Local client and daemon versions must match; compatibility handling is reserved for remote daemons,
separately versioned helpers, persisted artifacts, and released API consumers.

### Interactions, selectors, and refs

**Interactor**:
The legacy monolithic interface between dispatch and platform behavior, retained only for commands
not yet migrated to request-bound runtimes.
_Avoid_: New or migrated command behavior

**Interaction dispatch path**:
One concrete route an interaction command takes from a resolved target to device execution.

**Coordinate-first resolved element activation**:
An Apple interaction that resolves a semantic element and then activates its resolved center point,
avoiding a second element lookup after navigation.

**Parent-owned touch point**:
A point that preserves the selected parent's identity while avoiding independently interactive
descendants at its center.

**Guarantee cell**:
One dispatch-path-by-guarantee classification stating where an interaction guarantee is enforced,
delegated, inapplicable, or waived.

**Owned waiver**:
A guarantee gap with a tracking issue and explicit owner.

**Delegation-on-error**:
A fast path returning semantic failures to the shared path. It establishes failure-side handling,
not success-path parity.

**Parity table**:
A golden cross-language rule table consumed by both TypeScript and native tests.

**Coverage manifest**:
A contract test's declaration of the guarantee cells it proves.

**Ref frame**:
The session's authorization namespace for mutating `@ref` targets, containing a frozen observation
epoch and issuance scope separate from the latest operational snapshot.

**Frame expiry seam**:
The point immediately before a mutating device operation where the active ref frame becomes invalid.

**Mutation admission**:
The decision that an active ref frame's epoch and issuance scope authorize a requested ref mutation.

**Ref generation pin**:
An optional `~s<n>` suffix that carries the snapshot generation from which an `@ref` was minted.

**Deferred interaction outcome**:
Post-response state that records whether a mutation may still need outcome retry, stabilization, or
snapshot freshness recovery.

**Settled observation**:
An optional post-action observation that waits for a quiet UI and reports the difference from the
pre-action tree.

**Resolution disclosure**:
Bounded response evidence describing how an interaction target was resolved without issuing new
actionable refs.

### Gestures and touch

**Gesture plan**:
A typed, platform-neutral normalization of one- or two-contact gesture intent into bounded pointer
trajectories.

**Android planned-touch executor**:
The Android boundary that selects a provider-native or instrumentation-backed executor for a
normalized touch plan.

**Multi-touch geometry**:
The centroid, span, angle, translation, scale, and rotation used to construct two-contact motion.

### Snapshots and capture

**Raw AX node**:
A backend-owned accessibility value before snapshot presentation.

**Snapshot acquisition**:
One backend attempt's raw accessibility nodes and attempt-level capture facts.

**Presentation options**:
The policy input controlling how one snapshot acquisition becomes a public projection.

**Capture hint**:
The acquisition-facing view of a snapshot request, derived once from presentation options. It names
the projection a backend must serve, keeps raw traversal depth separate from regular presented depth,
and may narrow acquisition only where that backend can prove the narrowing complete.

**Regular presented-depth frontier**:
The acquisition boundary for an unscoped regular snapshot, measured against regular presented depth
after structural wrappers collapse. It is distinct from raw traversal depth.

**Snapshot eligibility**:
Membership in a presented snapshot projection, independent of whether a node is currently hittable.

**Clip fold**:
The regular projection's single visibility interpreter, run inside presentation for every backend:
viewport and scroll-container clipping, ancestor projection, scroll hints, and collapsed depth.
Platform differences enter as a fold policy, never as a backend exception.

**Presented node**:
A wire-facing snapshot value produced at the presentation boundary.

**Snapshot capture plan**:
An ordered set of capture backends executed under one shared wall-clock budget.

**Snapshot quality verdict**:
A structured statement of capture state, backend, degradation reason, effective depth, and collapsed
content.

**Snapshot projection**:
A view of one acquired tree. Interactive is a subset of regular, and regular is a subset of raw.

**Declared capture residue**:
A fidelity limit in acquired evidence that presentation cannot repair and must disclose.

**AX-unavailable target invalidation**:
The Apple behavior that discards a suspect cached application target after a root accessibility
failure so the next command reacquires it.

### Recording and replay

**Script recording**:
Session mode that captures portable actions and target evidence into a `.ad` script.
_Avoid_: Screen recording

**Recorded input parameterization**:
An explicit fill contract that sends literal text to the live app while storing a caller-chosen
`${VAR}` placeholder in durable records.

**Open-to-destination script**:
A self-contained `.ad` script that opens an app, reaches and verifies a destination, and leaves the
session active.

**Destination guard**:
A selector-targeted wait near the end of an open-to-destination script that verifies its ready state.

**Replay script source bundle**:
The complete caller-resolved set of script paths and contents needed for one replay or test run.

**Screen-recording facet**:
A runtime facet that starts video capture and returns a live handle plus a durable descriptor.

**Live resource handle**:
Process-local authority to finish or forcibly dispose active logging, recording, or profiling work.

**Durable resource descriptor**:
Bounded, versioned identity and recovery state from which the same runtime owner can reattach to a
resource.

**Reattachment**:
A fenced recovery attempt by the descriptor's exact runtime owner that returns a live handle,
completed result, missing state, or typed refusal.

### Maestro compatibility

**Maestro program**:
A source-preserving typed representation of the Maestro Flow syntax and behavior supported by
agent-device, interpreted through the compatibility runtime.

**Maestro observation generation**:
Compatibility-engine evidence captured since the most recent mutation; mutation invalidates it
before dispatch.

### Providers and tests

**Provider**:
An external adapter that owns a device runtime or contributes transport to a platform module.

**Provider-backed integration scenario**:
A device-free test through the real daemon request path that replaces only external device or host
tool execution.

**Cloud WebDriver runtime**:
A provider runtime that maps a cloud-owned Appium or WebDriver session into agent-device inventory,
leases, runtime behavior, artifacts, and release.

**Cloud artifact**:
Provider-hosted session output such as video, automation logs, device logs, or dashboard links.

**Daemon artifact type**:
An optional semantic category supplied by the owner of a daemon-managed downloadable artifact.

**Provider transcript**:
An exact record of external provider calls used to verify command translation.

**Scenario transcript**:
A command-level integration flow describing user-visible behavior through daemon commands.

**In-process provider scenario harness**:
An integration runner that invokes the daemon request handler without opening an HTTP listener.

**HTTP contract test**:
A narrow test of JSON-RPC transport, authentication, and response finalization.
