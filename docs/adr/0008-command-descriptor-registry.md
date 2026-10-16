# ADR 0008: Command Descriptor Registry

## Status

Accepted

Completed process history is in git history.

> **Amended by [ADR 0019](0019-request-bound-platform-runtime.md).** `CommandDescriptor` remains the root for command declarations.
> Device-command capability buckets evolve into typed required and preferred runtime use with leaf/device/provider-specific runtime facts.
> Inventory commands declare inventory use instead of a fabricated device binding.
> The descriptor's other derived projections remain accepted.
>
> No parity test exists.
> Do not add or search for one.
> Compile-time guards (`CommandOwnerFileClaimsAreComplete`) and literal pin-set tests now enforce totality.
> Those tests compare name sets instead of two tables.

## Rules at a glance

- Compose one `CommandDescriptor` per command from facets owned by their domains.
- Derive consumer tables through pure projections.
- Keep shared narrow command traits on the descriptor.
- Keep client `invoke` and in-daemon `execute` distinct across the process boundary.
- Preserve all four invariants from ADR 0003.
- The descriptor module must own `Input`/`Result` types. Derive the client as a view type under a lint boundary.

## Context

Roughly ten manually maintained tables repeat command identity and require alignment by convention:

- `PUBLIC_COMMANDS` in `src/command-catalog.ts`.
- Per-command metadata and family facets in `src/commands/**`.
- Capability matrix in `src/core/capabilities.ts`.
- Daemon command registry in `packages/daemon/src/core/daemon-command-registry.ts` (ADR 0003).
- Structured-batch allowlist in `src/batch-policy.ts`.
- MCP exposure sets.
- Node client interface and implementation in `src/client-types.ts` and `src/client.ts`.
- Generic-dispatch `switch` in `src/core/dispatch.ts`.

The switch's `default: throw` makes a missing or renamed command a runtime error instead of a compile error.
One new command changes approximately 24 files.
Its argument shape is serialized or deserialized approximately four times.
Three places repeat the gesture set.

`CommandFamilyFacet` in `src/commands/family/` already proves that derivation works for part of this problem.
It derives MCP tools, CLI schema, and batch writer from one array.
However, derivation stops at the command-surface boundary.
Beyond it, tables remain manually maintained.

ADR 0003 deliberately gives daemon route/policy a separately owned internal registry with a small predicate interface.
Its 2026-06 update defines four invariants for any single-declaration derivation model.
This ADR defines that model.

## Decision

Introduce one `CommandDescriptor` per command.
It **composes facets owned by their domains**.
Every consumer table is **derived** through pure projection:

- The descriptor composes catalog identity, command-family surface projection hooks, `capability`, `daemon`, platform dispatch membership, response data transforms, and typed-result hooks.
  `src/commands/**` retains CLI schema/reader and executable surface metadata ownership.
  ADR 0003 defines the daemon facet's route and request-policy traits.
- Narrow command traits that affect multiple projections belong to the descriptor.
  Interaction post-action observation (`--settle` / `--verify`) is one example.
  CLI flags, command metadata, timeout policy, and tests derive from one fact instead of repeated command-name lists.
- These surfaces become pure projections of the descriptor set:
  - Public catalog.
  - Capability matrix.
  - Daemon command registry.
  - Batch allowlist.
  - MCP tool list.
  - CLI schema exposure.
  - Descriptor-backed Node client surface.
  A total map keyed on the command-name union replaces the `src/core/dispatch.ts` `switch`.
  A missing handler therefore causes a compile error.
- Cross-process client `invoke` and in-daemon `execute` remain distinct.
  The process boundary is never removed.

This design follows all four ADR 0003 invariants:

1. Daemon-owned declaration, never inline in the public surface.
2. Unchanged predicate interface.
3. No daemon-only traits in public projections.
4. One declaration per concern, enforced by types.

## Alternatives Considered

- **Keep manually synchronized tables.** This avoids migration risk.
  However, each command still costs approximately 24 changed files, with alignment enforced only by convention and tests.
- **Use one flat public descriptor with inline daemon fields.** This puts daemon-only policy in the public command surface.
  ADR 0003 and its update explicitly forbid this ownership combination.
- **Generate code at build time.** This is a valid option.
  However, runtime derivation with `as const satisfies` retains the source of truth in type-checked TypeScript.
  It requires no separate build step or generated artifacts for review.

## Consequences

A plain new command changes approximately 1–2 files.
Per-platform behavior remains N implementations behind the descriptor's `execute`.
The descriptor is a prerequisite for typed per-command results in ADR 0010, which deletes the `src/client-types.ts` mirror.
It also supplies the capability facet used by the platform-plugin work in ADR 0009.

Import-cycle inversion is the principal risk.
`command-catalog.ts` has approximately 95 importers, and the family facet currently imports `AgentDeviceClient`.
Thus, the descriptor module must own `Input`/`Result` types.
The client must be derived as a view type, enforced by a lint boundary.
The descriptor registry supplies:

- Command identity: `PUBLIC_COMMANDS`, `INTERNAL_COMMANDS`, and local CLI names.
- Daemon registry traits.
- Capability matrix.
- Structured-batch allowlist.
- Daemon-client timeout policy.
- MCP exposure list.
- Capability-checked CLI command list.
- Post-action observation traits.
- Platform dispatch command set, including the remaining dispatch-only alias `read`.

Command-family surface metadata remains under `src/commands/**`, beside CLI grammar and client-backed executors.
Coherence checks compare it with the descriptor CLI catalog.
Thus, new surface names cannot differ from the descriptor root.

Public Node-client typed-result narrowing remains deferred outside this registry migration in [#1153](https://github.com/callstack/agent-device/issues/1153).
Some commands still expose dynamic daemon response payloads or retain closed result contracts in runtime modules.
Before their client methods can stop returning `CommandRequestResult`, those contracts must move.
