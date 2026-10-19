# ADR 0008: Command Descriptor Registry

## Status

Accepted. This record absorbed [ADR 0003](0003-daemon-command-registry.md), which now redirects here.

Amended by [ADR 0019](0019-request-bound-platform-runtime.md): device capability buckets became typed runtime use joined with request-bound runtime facts. The other derived projections remain accepted.

## Rules at a glance

- Declare each command once in the descriptor registry. Compose the declaration from facets owned by their domains. No second table declares the same traits.
- Derive every shared consumer table as a pure projection. Do not copy a derived classification back into a consumer as a hand-authored set.
- Keep a narrow fact on the descriptor when several projections consume it: `timeoutPolicy`, `recordingEffect`, `postActionObservation`.
- Keep grammar, decoding, executable surface metadata, and client invocation in `src/commands/**`. Keep shared option and result data in domain contracts. Keep the client facade in the client layer.
- Declare daemon route and request policy in the separately typed `daemon` facet. Derive the daemon registry from it. Expose request-policy predicates only through the daemon registry.
- Request modules consume named predicates. Handler modules own execution logic only. Neither recreates command sets or coverage tables.
- Public grammar, client options, MCP schemas, help, and capability contracts must not derive from daemon-only traits. A diagnostic display, such as `command explain`, may show them.
- Allow at most one `daemon` facet per command. If the facet is absent, the command uses the `generic` route and default request policy.
- Keep the cross-process `invoke` seam and the in-daemon `execute` seam distinct. Never collapse the process boundary.
- Enforce completeness with name, trait, and owner guards. Do not add parity tests against the deleted hand-authored tables.
- Narrow a client method's result only after an accurate closed contract exists. Keep dynamic results as `CommandRequestResult`.

## Decision

### One declaration site

Declare each command once as a `CommandDescriptor` in `packages/command-registry/src/registry.ts`. The root is synchronous: each derived view is a module-scope value, which keeps the literal-union and compile-time totality guarantees [ADR 0027](0027-descriptor-root-vs-eager-closure-budget.md) relies on.

The descriptor composes facets owned by their domains: catalog identity, command-family surface hooks, the `platformExecution` declaration, the `daemon` facet, `timeoutPolicy`, batch and MCP membership, `deviceClaimPolicy`, `postActionObservation`, response data transforms, and typed-result hooks. The public catalog, the batch allowlist, the MCP exposure list, the client timeout policy, and the daemon registry are pure projections of that set.

Keep a narrow fact on the descriptor when more than one projection consumes it. `timeoutPolicy` replaced the two hand-maintained client timeout lists (ADR 0011). `recordingEffect` drives the daemon's recording and mutation decisions. `postActionObservation` drives `--settle` / `--verify` flags, command metadata, and tests.

### Domain-owned surfaces

Keep CLI grammar, input decoding, executable surface metadata, and client-backed invocation in `src/commands/**`. Keep shared option and result shapes in domain contracts under `packages/contracts/src`: both surfaces need that vocabulary, so a shared shape sits below both. A type-only dependency on the `AgentDeviceClient` facade from a command module is an accepted ratchet-bounded position, not shared data that must move to contracts. The facade declares its signatures in that vocabulary. Add a type projection only when it removes real duplication across consumers.

The client `invoke` seam is cross-process; the daemon `execute` seam runs the platform handler inside the daemon process. The process boundary is never collapsed.

The `platformExecution` declaration names the execution shape: `none`, `host`, `inventory`, or `device-runtime`, each with its runtime use where required. [ADR 0019](0019-request-bound-platform-runtime.md) request-bound runtime facts and facets own platform admission and execution. Do not restore the retired capability matrix or generic dispatch switch.

### Daemon ownership

Declare daemon route and request-policy traits in the `daemon` facet. `DaemonCommandDescriptor` in `packages/command-registry/src/daemon-command-descriptor.ts` owns that type.

`packages/daemon/src/core/daemon-command-registry.ts` derives its table through `deriveDaemonCommandDescriptors(commandDescriptors)`. Only that module exposes the named predicates, such as `getDaemonCommandRoute`, `isLeaseAdmissionExempt`, and `shouldLockSessionExecution`. A duplicate command name throws when the registry builds. Without a `daemon` facet, each predicate falls back to the `generic` route and the default request policy.

No public contract may derive from daemon-only traits. This is an ownership constraint, not type enforcement: the current types neither block an accidental read by a public projection nor force a compile error for a missing facet. Reviewers and the registry tests hold the boundary. `command explain` in `src/cli/command-explain.ts` may read the facet.

### Completeness guards

Typed requirements and literal pins enforce completeness: `as const satisfies` on the descriptor array, `CommandOwnerFileClaimsAreComplete` for owner-file claims, and literal command-name pin sets in the registry tests. The hand-authored tables are all deleted, so a parity test has no second table to compare; `src/__tests__/command-descriptor-parity.test.ts` is an invariants-only guard. Do not add or search for one.

## Why

About ten hand-maintained tables once repeated command identity, route membership, and policy, aligned only by convention. One declaration with derived projections removes the drift. The separately typed `daemon` facet keeps daemon policy out of the public surface.

## Alternatives Considered

- **Keep manually synchronized tables.** This avoids migration risk. However, alignment held only by convention and tests.
- **Keep the daemon groups in the public catalog file.** This keeps one file for command names. However, it mixes public command identity with daemon runtime policy and grows the catalog for internal-only decisions.
- **Keep handler-local coverage tables.** Each handler would describe its routes locally. However, this creates a second source of route membership that can disagree with the router and the request-policy modules.
- **Put route checks directly in request modules.** This is locally simple. However, command classification spreads across admission, locking, provider scope, replay, recording, and generic dispatch.
- **Use one flat public descriptor with inline daemon fields.** This puts daemon-only policy into the public command surface, which the ownership boundary above forbids.
- **Generate code at build time.** This is valid. However, runtime derivation with `as const satisfies` keeps the source of truth in type-checked TypeScript and needs no generated artifacts.
- **Project the client surface from descriptors as a phantom view type.** PR #2294 removed it: it had one consumer, and direct facade signatures preserved the published contract with less machinery.

## Consequences

- When you add or move a daemon-handled command, declare its `daemon` facet in its descriptor. The daemon registry derives the entry.
- Registry tests pin the derived tables as literal name sets, so a reclassification edits the pinned list in the same diff. Provider-backed integration scenarios verify important request-policy behavior through the real daemon request path.
- Open gap: several client methods still return `CommandRequestResult` (`alert`, `reactNative`, most `interactions.*`). Some commands expose dynamic daemon response payloads and have no closed contract to name. The closure of issue #1153 does not establish complete result narrowing.
- Open gap: no rule blocks a public projection from reading the `daemon` facet by accident; only review and tests detect it.
- Open gap: a missing `daemon` facet is silent by design (generic route and default policy), so a forgotten declaration is a behavior bug, not a compile error.

## Decision history

- 2026-09-05 — [#2294](https://github.com/callstack/agent-device/pull/2294) removed the navigation-only phantom-type projection: direct signatures were simpler and preserved the published contract.
