# ADR 0008: Command Descriptor Registry

## Status

Proposed

## Context

A command's identity is restated, by hand, across roughly ten tables that must stay aligned by
convention: `PUBLIC_COMMANDS` (`src/command-catalog.ts`), the per-command metadata and family facets
(`src/commands/**`), the capability matrix (`src/core/capabilities.ts`), the daemon command registry
(`src/daemon/daemon-command-registry.ts`, ADR 0003), the structured-batch allowlist
(`src/batch-policy.ts`), the MCP exposure sets, the Node client interface and impl (`src/client-types.ts`,
`src/client.ts`), and the generic-dispatch `switch` (`src/core/dispatch.ts`, whose `default: throw` makes a
missing or renamed command a runtime error, not a compile error). Adding one command touches ~24 files, the
argument shape is (de)serialized ~4 times, and the gesture set is retyped in three places.

The codebase already proves the cure works for part of this: the `CommandFamilyFacet`
(`src/commands/family/`) derives the MCP tools, the CLI schema, and the batch writer from a single array.
It simply stops at the command-surface boundary; everything past it is hand-maintained.

ADR 0003 deliberately separated daemon route/policy into its own internally-owned registry with a small
predicate interface, and its 2026-06 update set four invariants that any single-declaration/derivation
model must preserve. This ADR is that model.

## Decision

Introduce one `CommandDescriptor` per command that **composes facets owned by their domains** and from which
every consumer table is **derived** by pure, parity-tested projection:

- The descriptor composes a `surface` facet (owned by `src/commands/**`: identity, CLI schema/reader, MCP),
  a `capability` facet (owned by `src/core/capabilities`), and a `daemon` facet (route + request-policy
  traits, **owned under `src/daemon/`** per ADR 0003), plus a typed result.
- Narrow command traits that affect multiple projections, such as interaction post-action observation
  (`--settle` / `--verify`), live on the descriptor so CLI flags, command metadata, timeout policy, and
  tests derive from one fact instead of repeating command-name lists.
- The public catalog, capability matrix, daemon command registry, batch allowlist, MCP tool list, CLI
  schema, and the Node client surface become pure projections of the descriptor set. The
  `src/core/dispatch.ts` `switch` is replaced by a total map keyed on the command-name union, so a missing
  handler is a compile error.
- The cross-process `invoke` (client) and in-daemon `execute` seams stay distinct; the process boundary is
  never collapsed.

This **composes with**, and is bound by, ADR 0003's four invariants: daemon-owned declaration (never inlined
into the public surface), the predicate interface unchanged, no leakage of daemon-only traits into public
projections, and one declaration per concern enforced by the type system.

## Alternatives Considered

- Keep the hand-synced tables: no migration risk, but it is the status quo this ADR exists to remove —
  ~24-file cost per command and drift kept in check only by convention and tests.
- A single flat public descriptor with daemon fields inlined: re-contaminates the public command surface
  with daemon-only policy, which is exactly what ADR 0003 (and its update) forbid.
- Build-time code generation: a real option, but runtime derivation with `as const satisfies` keeps the
  source of truth in type-checked TypeScript with no separate build step or generated artifacts to review.

## Consequences

Adding a plain command touches ~1–2 files; per-platform behavior remains N implementations behind the
descriptor's `execute`. The descriptor is the prerequisite for typed per-command results (ADR 0010, which
deletes the `src/client-types.ts` mirror) and supplies the capability facet the platform-plugin work
(ADR 0009) hooks into.

Migration is **strangler-fig and sequential** — never a big-bang:

1. Introduce the `commandRegistry` as the root and **invert the import graph** so `command-catalog`,
   `capabilities`, `daemon-command-registry`, and `batch-policy` become leaves that derive from it.
2. Promote each family's facet to a full `CommandDescriptor`, family by family.
3. Replace the dispatch `switch` with the registry-driven total map, arm by arm.

Each derived table must be asserted **byte-for-byte equivalent** to the hand-authored table by a parity test
**before** the hand table is deleted. The principal risk is the import-cycle inversion: `command-catalog.ts`
has ~95 importers and the family facet currently imports `AgentDeviceClient`, so the descriptor module must
own the `Input`/`Result` types and the client must be derived as a view type, enforced by a lint boundary.
Until this lands and the registry tests pin it, the hand-authored tables remain the source of truth.

This ADR owns the decision and its constraints; the roadmap that prototyped it has been retired, with
the delivered end-state recorded in [CONTEXT.md](../../CONTEXT.md) (Architecture).
