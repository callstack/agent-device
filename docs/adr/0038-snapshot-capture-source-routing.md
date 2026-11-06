# ADR 0038: Snapshot capture source routing

## Status

Accepted.
This record owns snapshot source routing for every platform and provider.
It amends [ADR 0004](0004-ios-snapshot-backend-strategy.md), which keeps the iOS acquisition, presentation, geometry, and system-surface contracts.
The router does not exist yet. [#4205](https://github.com/callstack/agent-device/issues/4205) holds the migration plan and its guards.

## Context

Only iOS has a source-selection rule, in the Apple platform runtime.
Its runner source fills the route's ports with constants.
Eligibility has three owners, fallback has three settlers, and producer facts have about six tables.
Each other platform has one hard-wired source with its own refusal and identity vocabulary.

## Decision

**Router.** One platform-neutral router in `@agent-device/capture-kit` owns planning, fallback, refusal scope, circuits, surface proof, and warnings.
Owners with more than one source use the router.
Today these owners are the local and Limrun iOS Simulators: the simulator AX bridge first, then the XCTest runner.
The router depends on no platform or provider code.
Lease and lock authority stays with [ADR 0007](0007-remote-device-leases.md).

**One-source owners.** An owner with one source does not use the router.
It stamps identity through the capture-kit helper.
When an owner gets a second source, it moves to the router.

**Producers.** One contracts registry keys every producer with a platform-neutral name.
All other producer facts derive from that registry.

**Identity.** Stamp identity once, after presentation, from the source that served the capture.
When a system surface serves the capture, the surface owns the published identity, not the app generation below it.

**Fallback.** A capture tries one alternate source at most.
If the alternate fails, the capture keeps the first reason.
Cancellation is terminal: it neither falls back nor changes a circuit.
Never relax a backend pin or an observe-only request to make a fallback possible.
A source never routes to another source.

**Refusal scope.** Each typed refusal has one scope:

| Scope | Effect |
| --- | --- |
| Capture | The source stays eligible for the next capture. |
| App generation | The source stays disabled until the app has a new generation. |
| Runner session | The source stays disabled until the runner has a new session id. |

An unknown refusal code has app-generation scope.
Without a verified generation, the refusal disables the source for the current capture only and creates no circuit.
The refusal fixture is the one table of codes and scopes.
The router handles cancellation before it classifies a refusal.

**Surface proof.** Prove surface absence for each capture. Never cache it.
An unproven state is not a clear state: an app-only read must prove absence or refuse.
An occluded read selects a source that can read the surface.
A source that declares no proof asserts no absence.
Acquisition metadata, such as an Android system-only tree, is not a proof.
A future app-only source needs window-ownership evidence that is tied to its read.

## Rationale

- One rule makes fallback, refusals, and warnings the same on every platform. A new provider declares its sources and does not copy policy.
- The router applies only where a choice exists. A planner that never chooses adds migration cost and no value.
- An unknown refusal fails closed, so a failed source cannot stay eligible.
- A surface can appear between captures. A cached absence would publish an occluded read as app content.

## Rejected alternatives

- Placeholder ports on the Apple route: they claim capabilities that a source does not have.
- A planner for each provider: it duplicates policy, and the copies drift.
- Annotations as absence proof: they give no evidence from before the read.
- The router for one-source owners: the planner never chooses for them.

## Consequences

- Provenance types move from kernel to contracts, and both iOS sources bind to the router.
- Readers, decoding, discovery, process checks, native budgets, geometry, and lifecycle stay platform-specific.
- Open gaps: the router and the producer registry do not exist yet. The runner-session scope arrives with [#4256](https://github.com/callstack/agent-device/pull/4256). ADR 0004 must shrink below about 15 KB.
