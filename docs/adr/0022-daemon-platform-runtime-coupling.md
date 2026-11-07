# ADR 0022: Daemon platform runtime coupling and ownership

## Status

Accepted (2026-09-06). R76 enforces the daemon coupling ban. R75 ratchets handler authority. Completed process history is in git history.

## Context

The daemon must not depend on concrete platform code. This boundary alone does not establish whether each platform-aware responsibility belongs in the daemon. Session state and store authority also need a boundary for handlers. Route depth needs a deletion test, not a numerical budget that would fold necessary request-scope wrappers.

## Decision

R76 prohibits every production daemon import of the root platform-runtime family or a root hub that reaches it. The family is `src/platform-runtime.ts` and the src/platform-runtime-*.ts glob. The ban includes static and dynamic imports. Process-root composition is outside the daemon zone.

Apple session observation uses the neutral `AppleSessionObservation`. It supplies runner liveness, session identity, and sole-foreground-app observation. Recording health, device refresh, and open-hint policy consume it. Root composition supplies request-local inventory and its error classifier. The Apple platform package owns the probes. Selector production and lifecycle participation remain separate.

The daemon receives only the typed `PlatformOwnerLifecycle`. `src/platform-runtime-daemon-lifecycle.ts` alone composes it and imports the platform owners' cleanup and recovery mechanics. Platform owners participate through the existing lifecycle phases. Do not introduce a generic hook bag. Open-target plans and results remain separate from platform mechanics. The resolver remains the single construction path for an open plan. The live selector read uses the `querySelector` operation on the request-bound runtime owner. Its declaration is conditional on the captured touch and gesture uses. Off-screen rescue uses the command's admitted binding. Do not add a second selector producer.

R75 `session-authority-overlay` measures `SessionState` shape and `SessionStore` authority by symbol. It fails when a handler file enters either set and the merge-base set does not contain that file. The handler scope is the packages/daemon/src/{sessions,execution}/handlers/** glob. Handler files may leave either set. R75 does not ratchet reads outside the handler path. R7 and R10 own cross-module reads outside that path.

The route trace assigns each hop a role and tests each pass-through or translation hop for deletion. A route may collapse only pass-through or translation hops that the deletion test proves removable. The `bindRuntimeCommands` closure wrapper on the shared snapshot path is the only proven removable hop and the only endorsed collapse candidate; this record collapses none. The earlier ≤14 target is superseded. The request-spine guards are side-calls, not hops: auth comparison, cancellation gate, idle-reap timer reset, and Android freshness guard/clear. [ADR 0023](0023-end-state-hop-trace.md) owns the trace and deletion tests.

## Rationale and rejected alternatives

Platform-aware edges fall into three categories: composition-essential edges assemble neutral implementations at the process root; daemon-policy-essential edges own request admission, session ownership, conflicts, locking, cancellation, teardown ordering, artifact publication, or response and event semantics; platform mechanics and state belong behind a deeper interface or adapter.

Root composition and daemon policy can own neutral interfaces without exposing platform mechanics to the daemon. A generic lifecycle hook bag would bypass the existing phases. A second selector producer would duplicate snapshot-producer policy.

A repository-wide authority ratchet would prevent legitimate movement of reads that belong to their modules. The handler ratchet targets growth in handler state shape and store authority.

The ≤14 route target is not reachable without folding cross-cutting request-scope wrappers. The audit does not endorse that folding. A route collapse without a successful deletion test is not endorsed.

## Consequences

The layering gates enforce R76, R75, R7, R10, and R65. The process root owns runtime composition. Platform packages own platform mechanics. Handler files may leave the R75 sets but may not enter them relative to the merge base.
