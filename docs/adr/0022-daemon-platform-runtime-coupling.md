# ADR 0022: Daemon platform runtime coupling and ownership

## Status

Accepted. R76 enforces the daemon coupling ban. R75 ratchets handler authority.

## Context

The daemon must not depend on concrete platform code. This boundary alone does not establish whether each platform-aware responsibility belongs in the daemon. Session state and store authority also need a boundary for handlers. Route depth needs a deletion test, not a numerical budget that would fold necessary request-scope wrappers.

## Decision

R76 prohibits every production daemon import of the root platform-runtime family or a root hub that reaches it. The ban includes static and dynamic imports. Process-root composition is outside the daemon zone. Composition-essential edges assemble neutral implementations there. Daemon-policy-essential edges own request admission, session ownership, conflicts, locking, cancellation, teardown ordering, artifact publication, or response and event semantics. Platform mechanics and state belong behind a deeper interface or adapter.

Apple session observation uses the neutral `AppleSessionObservation`. It supplies runner liveness, session identity, and sole-foreground-app observation. Recording health, device refresh, and open-hint policy consume it. Root composition supplies request-local inventory and its error classifier. The Apple platform package owns the probes. Selector production and lifecycle participation remain separate.

Platform owners participate through the existing lifecycle phases. Do not introduce a generic hook bag. Open-target plans and results remain separate from platform mechanics. The resolver remains the single construction path for an open plan. Selector reads use the `querySelector` operation on the request-bound runtime owner. Its declaration is conditional on the captured touch and gesture uses. Off-screen rescue uses the command's admitted binding. Do not add a second selector producer.

R75 measures `SessionState` shape and `SessionStore` authority by symbol. It fails when a handler file enters either set and the merge-base set does not contain that file. Handler files may leave either set. R75 does not ratchet reads outside the handler path. R7 and R10 own cross-module reads outside that path.

The route trace assigns each hop a role and tests each pass-through or translation hop for deletion. Collapse only hops that the deletion test proves removable. The audited runtime-types hop is the only endorsed collapse. The earlier ≤14 target is superseded. The request-spine guards are side-calls, not hops. [ADR 0023](0023-end-state-hop-trace.md) owns the trace and deletion tests.

## Rationale and rejected alternatives

Root composition and daemon policy can own neutral interfaces without exposing platform mechanics to the daemon. A generic lifecycle hook bag would bypass the existing phases. A second selector producer would duplicate snapshot-producer policy.

A repository-wide authority ratchet would prevent legitimate movement of reads that belong to their modules. The handler ratchet targets growth in handler state shape and store authority.

The ≤14 route target is not reachable without folding cross-cutting request-scope wrappers. The audit does not endorse that folding. A route collapse without a successful deletion test is not endorsed.

## Consequences

The layering gates enforce R76, R75, R7, R10, and R65. The process root owns runtime composition. Platform packages own platform mechanics. Handler files may leave the R75 sets but may not enter them relative to the merge base.
