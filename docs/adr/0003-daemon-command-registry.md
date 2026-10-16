# ADR 0003: Daemon Command Registry

## Status

Accepted. Amended 2026-10-16: invariants 3 and 4 now describe the shipped derivation (#906, #907).

## Rules at a glance

- Keep public command identity in `packages/command-registry/src/catalog.ts` and public input/output contracts in `src/commands/**`.
- Declare daemon route ownership and request-policy traits in the separately typed `daemon` facet of the descriptor registry.
- Derive the daemon registry from that facet. Expose request-policy predicates only through the daemon registry.
- Request modules consume named predicates from the registry. They do not recreate command string sets.
- Handler modules own execution logic only. They do not export duplicate coverage tables to prove route membership.
- The daemon registry must not define CLI grammar, Node.js client options, MCP schemas, user-facing help, or platform capability support.
- Preserve all four invariants in the 2026-06 update.
- Do not derive a public contract from daemon traits. A diagnostic display, such as `command explain`, may read them.
- A command without a `daemon` facet uses the `generic` route with default request policy.

## Context

Daemon request behavior depends on traits outside the public command surface:

- Which handler route owns a command.
- Whether tenant lease admission applies.
- Whether session execution should lock.
- Whether selector validation applies.
- Whether replay can run an action in the current session scope.
- Whether invalid recordings block the request.
- Whether Android blocking-dialog recovery applies.
- How request-scoped providers resolve a device.

Previously, `src/command-catalog.ts`, request-policy modules, and handler-local coverage tables each held some of these traits.
Thus, `src/command-catalog.ts` contained daemon-only behavior beside public command identity.
Duplicate command sets required alignment by convention.

## Decision

Keep public command identity in `packages/command-registry/src/catalog.ts`.
Keep public input/output contracts in `src/commands/**`.

Declare command route ownership and request-policy traits in the `daemon` facet in `packages/command-registry/src/registry.ts`.
`DaemonCommandDescriptor` in `packages/command-registry/src/daemon-command-descriptor.ts` types that separate facet.
`packages/daemon/src/core/daemon-command-registry.ts` derives its table through `deriveDaemonCommandDescriptors(commandDescriptors)`.
Request modules consume predicate functions from the registry.
They do not recreate command string sets.
Handler modules own execution logic only.
They do not export duplicate coverage tables to prove route membership.

The daemon registry is internal-only.
It must not define:

- CLI grammar.
- Node.js client options.
- MCP schemas.
- User-facing help.
- Platform capability support.

The command contract, projection, help, and capability modules retain these responsibilities.

## Alternatives Considered

- **Keep daemon groups in `src/command-catalog.ts`.** This retains one file for command names.
  However, it mixes public command identity with daemon runtime policy.
  It also increases catalog size for internal-only route decisions.
- **Keep handler-local coverage tables.** Each handler describes its routes locally.
  However, this creates a second source of route membership that can disagree with the router and request-policy modules.
- **Put route checks directly in request modules.** This is locally simple.
  However, command classification becomes distributed across admission, locking, provider scope, replay, recording, and generic dispatch.

## Consequences

When a daemon-handled command is added or moved, update its `daemon` facet in `packages/command-registry/src/registry.ts`.
The daemon registry derives its table from those declarations.
The registry tests pin the trait decisions.
Provider-backed integration scenarios verify important request-policy behavior through the real daemon request path.

The registry file is intentionally a dense internal contract.
Its interface should remain small.
Callers ask daemon-policy questions through named predicates.
They do not read or mutate command sets.

`AGENTS.md` should contain only the operating rule and relevant file pointers for agents.
This ADR owns the rationale.
Thus, future changes do not require readers to infer the rationale from agent instructions.

## Update (2026-06): single-declaration / derivation model

The implemented `CommandDescriptor` direction in [ADR 0008](0008-command-descriptor-registry.md) unifies a command's declarations at one registration site.
It derives these surfaces from that site:

- Public catalog.
- Capability matrix.
- CLI/MCP projections.
- Batch allowlist.
- Daemon registry.

Its purpose is to remove the drift between these tables.
Registry tests pin the derived tables.

**This ADR's decision remains accepted.**
Its boundary concerns ownership and the predicate interface, not the physical file that contains a trait.
“Separate source of truth” means separate ownership and exposure through named predicates.
That property remains true for a projected or derived backing table.
A derived daemon registry is therefore permitted **only if** it preserves all these invariants:

1. **Daemon-owned declaration.** The separately typed `daemon` facet in `packages/command-registry/src/registry.ts` declares route and request-policy traits.
   `DaemonCommandDescriptor` in `packages/command-registry/src/daemon-command-descriptor.ts` owns its type.
   The registration composes that facet.
   The public command contract in `src/commands/**` or `packages/command-registry/src/catalog.ts` must never contain these traits as inline fields.
   A registration call may be co-located with public declarations.
   Ownership of daemon policy must remain separate from the public surface.
   See Alternatives, “Keep daemon groups in `src/command-catalog.ts`”.
2. **Predicate interface unchanged.** Consumers continue to use named predicates such as `getDaemonCommandRoute`, `isLeaseAdmissionExempt`, and `shouldLockSessionExecution`.
   Only the daemon registry exposes these predicates.
   Derivation changes table construction, not table access.
3. **No daemon traits in public contracts.** CLI grammar, Node.js client options, MCP schemas, user-facing help, and capability support must not derive from daemon-only traits.
   A diagnostic display may read the `daemon` facet. `command explain` in `src/cli/command-explain.ts` displays routes and request-policy traits this way.
4. **One declaration per command.** Each command has at most one `daemon` facet, at its registration in the descriptor registry.
   No second table declares the same traits. This replaces alignment by convention, and it justifies derivation instead of a separate hand-authored table.
   A command without a `daemon` facet uses the `generic` route with default request policy. The daemon registry tests pin the derived table.

A single flat public descriptor that exposes daemon fields in public views is **not** permitted.
This would combine daemon policy with a public command registry, which this ADR rejects.
Compose facets owned by their domains.
Derive the registry from those facets.
PR #906 introduced the descriptor and proved parity.
PR #907 made the derivation live and deleted the hand-authored table.
The daemon registry tests pin route and request-policy decisions.

**Amendment 2026-10-16.** The 2026-06 text required types to stop every public projection from reading daemon traits, and required a compile error for a missing daemon trait.
The shipped derivation does neither: `CommandDescriptorBase.daemon` is optional (`packages/command-registry/src/types.ts`), and a command without a facet gets the `generic` route.
Invariants 3 and 4 now state the property that matters and that the code holds: no public contract derives from daemon traits, and no second table declares them.
