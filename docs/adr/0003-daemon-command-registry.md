# ADR 0003: Daemon Command Registry

## Status

Accepted

## Rules at a glance

- Keep public command identity in `packages/command-registry/src/catalog.ts` and public input/output contracts in `src/commands/**`.
- Keep daemon route ownership and request-policy traits in the daemon command registry.
- Request modules consume named predicates from the registry. They do not recreate command string sets.
- Handler modules own execution logic only. They do not export duplicate coverage tables to prove route membership.
- The daemon registry must not define CLI grammar, Node.js client options, MCP schemas, user-facing help, or platform capability support.
- A derived daemon registry is permitted only if it preserves all four invariants in the 2026-06 update.

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

Add `packages/daemon/src/core/daemon-command-registry.ts` as the daemon-side source of truth for command route ownership and request-policy traits.
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

When a daemon-handled command is added or moved, its route and request-policy traits require updates in the daemon command registry.
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

A later proposal, the `CommandDescriptor` direction in [ADR 0008](0008-command-descriptor-registry.md), unifies a command's declarations at one registration site.
It derives these surfaces from that site:

- Public catalog.
- Capability matrix.
- CLI/MCP projections.
- Batch allowlist.
- Daemon registry.

Its purpose is to remove the drift between these tables.
Convention keeps several of these surfaces aligned against that drift.

**This ADR's decision remains accepted.**
Its boundary concerns ownership and the predicate interface, not the physical file that contains a trait.
“Separate source of truth” means separate ownership and exposure through named predicates.
That property remains true for a projected or derived backing table.
A derived daemon registry is therefore permitted **only if** it preserves all these invariants:

1. **Daemon-owned declaration.** A daemon-owned facet under `packages/daemon/src/` declares route and request-policy traits.
   The registration composes that facet.
   The public command contract in `src/commands/**` or `packages/command-registry/src/catalog.ts` must never contain these traits as inline fields.
   A registration call may be co-located with public declarations.
   Ownership of daemon policy must remain separate from the public surface.
   See Alternatives, “Keep daemon groups in `src/command-catalog.ts`”.
2. **Predicate interface unchanged.** Consumers continue to use named predicates such as `getDaemonCommandRoute`, `isLeaseAdmissionExempt`, and `shouldLockSessionExecution`.
   Only the daemon registry exposes these predicates.
   Derivation changes table construction, not table access.
3. **No leakage into public projections.** Types must prevent the catalog/CLI/MCP/help/capability projections from reading daemon-only traits.
   The daemon registry must still not define CLI grammar, Node.js options, MCP schemas, user-facing help, or capability support.
4. **One declaration per concern, enforced by types.** At the single registration site, a missing or duplicate daemon trait must cause a compile error.
   This replaces alignment by convention.
   This structural improvement justifies derivation instead of a separate hand-authored table.

A single flat public descriptor that exposes daemon fields in public views is **not** permitted.
This would combine daemon policy with a public command registry, which this ADR rejects.
Compose facets owned by their domains.
Derive the registry from those facets.
Until that derivation is implemented and the registry tests pin it, the hand-authored `packages/daemon/src/core/daemon-command-registry.ts` remains the source of truth.
Until then, the operating rule in `AGENTS.md` does not change.
