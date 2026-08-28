# Dependency graph findings

Snapshot analysis of the production import graph — 918 files, 25 zones — taken while doing the
boundary work across #1405 and its follow-ups. It is a dated observation, not a normative
document; when it disagrees with `scripts/layering/`, the gate wins.

Two ways to reproduce any number below. `pnpm depgraph` (#1410) emits the whole graph as JSON plus a
summary, and is the tool to reach for when you want the reachability or cycle analysis it computes. A
*rendered* viewer was also built and dropped — ~2200 lines and a Fallow exemption for a picture
neither a human nor an agent drew a conclusion from; the analysis survived, the rendering did not.

For a one-off question, a throwaway probe against the gate's own model is faster and leaves nothing
to clean up:

```ts
// scripts/layering/.probe.ts (throwaway; the gate's model is the only dependency)
import fs from 'node:fs';
import { listSourceFiles } from './check.ts';
import { resolveImportEdges, typeInversionPair, backEdgePair } from './model.ts';

const files = listSourceFiles();
const sources = new Map(files.map((f) => [f, fs.readFileSync(f, 'utf8')]));
const edges = resolveImportEdges(sources);

// e.g. R6 inversions per zone pair, deduplicated by file pair — reproduces
// TYPE_INVERSION_BASELINE, so a mismatch means one of the two is stale.
const seen = new Set<string>();
const byPair = new Map<string, number>();
for (const edge of edges) {
  const pair = typeInversionPair(edge);
  if (!pair) continue;
  const id = `${edge.file} -> ${edge.target}`;
  if (seen.has(id)) continue;
  seen.add(id);
  byPair.set(pair, (byPair.get(pair) ?? 0) + 1);
}
console.log([...byPair].sort((a, b) => b[1] - a[1]));
```

Run with `node --experimental-strip-types scripts/layering/.probe.ts` and delete it after. Swap
`typeInversionPair` for `backEdgePair` for R5, or group `edges` by `fromZone`/`toZone` for
zone-level traffic. Deduplicating by file pair matters: the gate counts each file pair once, so a
raw edge count reads higher.

## Where this round landed

|                                                          | before                 | after                                           |
| -------------------------------------------------------- | ---------------------- | ----------------------------------------------- |
| type-only spine inversions (R6)                          | 61 across 6 zone pairs | **7 across 4**, ratcheted                       |
| files in the unranked `(root)` zone                      | 29                     | **13** — entrypoints and composition roots only |
| files covered by the ranked spine                        | 713 of 898             | **888 of 901**                                  |
| type imports pointing at a re-export hub in another zone | 89                     | **0**                                           |
| selector-command rules stated in both zones              | 10 messages, 3 drifts  | **0** — shared in `selectors/`                  |
| modules writing ADR 0014's four ref-frame fields         | 2                      | **1**, enforced by R7                           |
| value-import cycles (R4) / spine back-edges (R5)         | 0 / 0                  | 0 / 0                                           |

What moved: the platform-plugin contract and its four facet tags, `NetworkEntry`, the
click-button / recording-export-quality / interactor-types / runner-lease-context vocabularies,
and 16 internal modules out of `(root)`; `utils` joined the spine at rank 1 after its two upward
files moved to the zones they were reaching for. Three new gate scopes keep it: R6 ratchets
type-only inversions, R7 pins SessionState field ownership, and the shared selector checks in
`selectors/` are covered by their own tests.

## What the gate guarantees, and what it cannot see

- **0 production value-import cycles** (R4), **0 spine back-edges** (R5), and type-only inversions
  pinned by the R6 ratchet.
- **Internal barrels are effectively gone.** One re-export-only file remains (`sdk/index.ts`,
  4 lines); `sdk/` totals 79 lines across 11 files — the legacy alias surface `CONTEXT.md` already
  gates for the next major.
- The **ADR 0017 parameterization boundary is exactly where the ADR says it is**:
  `daemon/parameterized-recorded-fill.ts` has precisely two dependents — the response boundary
  (`handlers/interaction-common.ts`, step 3) and the recorder boundary
  (`session-action-recorder.ts`, step 4). The two-pass structure is two call sites, not a scattered
  concern.
- Still outside every rule: **dynamic** import direction (0 inversions today, nothing watching),
  and anything inside a zone.

## 0. Where the inversions ended up (and why 5 is the floor for now)

The last pass moved four keystones, each of which was pinning a much larger set:

| Keystone moved to `contracts/` | Unblocked |
|---|---|
| `DaemonBatchStep` (was `core/batch.ts`, typed via `DaemonRequest['runtime']`) | `CommandFlags` |
| `CommandFlags` (was `core/dispatch-context.ts`) | `SessionAction`, `DispatchedCommand` |
| `TargetAnnotationV1` shape (was `replay/target-identity.ts`) | `SessionAction` |
| `ScrollInputDirection`, Metro result payloads | `ScrollOptions`, `MetroPrepareResult`/`MetroReloadResult` |

Two of those deserve their own note, because the pattern repeats: `DaemonBatchStep`'s `runtime` field
was written `DaemonRequest['runtime']`, pulling the whole daemon request type in to say
`SessionRuntimeHints` — the same type three zones lower. And `CommandFlags` was a single rank-2
declaration pinning ~80 public API shapes above it. Neither looked like a keystone from the graph;
both were found by asking "what does the target itself import, and what rank is that?"

`DaemonRequest` had been conflating a request with the command that request dispatches. There are
still only two request shapes — and that is the point, because a third would be a third name for the
same thing:

- `kernel/contracts.ts` `DaemonRequest` — the **wire** shape, `flags?: Record<string, unknown>`,
  because a process boundary cannot enforce a flag vocabulary;
- `daemon/types.ts` `DaemonRequest` — the wire shape with `token`/`session` required, `flags`
  narrowed to `CommandFlags`, and `internal?: DaemonRequestInternal` carrying `SessionState`
  callbacks and the admitted lease. Server-private, and why it cannot move down.

`core/command-descriptor/` had been importing the second to read `command`, `positionals` and
`flags` — reaching up two ranks for three fields. It now takes
`contracts/dispatched-command.ts` `DispatchedCommand`, which is those three fields and nothing else,
with `command`/`positionals` `Pick`ed from the wire so they cannot drift from it. Every descriptor
resolver already read only those three, in two spellings (the full type and a `Pick` of it); one
narrow name replaced both.

**The remaining 5 are positions, not debt** — each for a mechanical reason, not an appeal to an ADR:

- **4 × `AgentDeviceClient`** (`commands/command-contract.ts`, `commands/command-surface.ts`,
  `commands/family/types.ts`, `mcp/command-tools.ts`). The facade cannot move below `commands/`
  because it is *built from* the command surface: `client/client-types.ts` imports
  `ProjectedNavigationCommandClient` from `commands/system/navigation-projection.ts`. That is a real
  zone-level type cycle, and breaking it means deciding where the projection registry belongs — a
  design call, not a file move. A narrower port does not exist either: 4 files *name* the facade,
  but 26 call sites use methods across 13 of its namespaces, so any port would re-declare it.
- **1 × `DaemonCommandRoute`** (`commands/command-explain.ts`). The union lives in core so
  descriptors can name a route without importing the daemon, and the handler table covers it with
  `satisfies Record<DaemonCommandRoute, …>`. `command-explain.ts` still type-imports the re-export
  from `daemon-command-registry.ts` to key an exhaustive owner-file map; that remaining inversion
  is the commands-zone consumer, not a second source of truth for the union.

All remaining inversions are argued at `TYPE_INVERSION_BASELINE` in `scripts/layering/check.ts`, next
to the numbers they explain.

## 0b. The biggest structural finding is not an inversion

> **Current status at `e545544dfa85`:** R9 remains 102, but membership is now commands 33,
> daemon-server 30, platforms 19, core 12, root composition 5, contracts 2, and client 1. None of
> the native replay, replay-test, or Maestro engine files is in this component. A graph
> counterfactual removing the concrete Apple `perf-xctrace.ts` type edge from `daemon/types.ts`
> lowers it to 91 (and daemon membership from 30 to 21). Removing only the Android `perf.ts` edge
> leaves both counts unchanged at 102/30; removing both produces the same 91/21 as the Apple cut
> alone. The Apple edge is load-bearing, while removing the Android edge is ownership hygiene.
> Engine extraction alone leaves R9 at 102.

Cycle size by edge kind, measured over the whole production graph:

| edges considered | largest strongly-connected component |
|---|---|
| value only | **1** — no cycles, which is what R4 enforces |
| value + type-only | **102 files** |
| value + dynamic | **1** |
| all kinds | 213 files |

At runtime the module graph is a clean DAG. The 102-file cluster is purely type-level: you cannot
read the types of any one of those files without transitively reaching all 102. (`main` carried 107;
the current boundary moves bring it to 102.) That is not a correctness problem — types are erased —
but it is a comprehension one, and it is the single largest obstacle to reading a subsystem in
isolation. At the current measured commit it spans `commands` (33), `daemon-server` (30),
`platforms` (19), `core` (12), root composition (5), `contracts` (2), and `client` (1).

Now ratcheted for growth by **R9** (`TYPE_CYCLE_BASELINE`, derived from the zone ceilings in
`scripts/layering/daemon-modularity.ts`), so it cannot get worse
while nobody is looking — a type-only import that closes a new loop fails the gate, verified by
adding one type-only import that closes a loop and watching the gate reject it. It was growth-only
here; #1781 A6 made it an equality pin, so a baseline left above the measured size fails too and a
shrink is banked by the change that earns it. The refactor itself is still deliberately not
attempted; it starts at those four hubs.

### The facade cycle: investigated, no narrower port exists

The 4 remaining `-> client` inversions are `AgentDeviceClient` used as an opaque handle. The obvious
fix is a narrower port in `contracts/` describing only what `commands/` needs, with `client/`
satisfying it. Measured before attempting it:

| | count |
|---|---|
| Files *naming* `AgentDeviceClient` (i.e. the inversions) | 4 |
| Files *calling* client methods | 26 |
| Distinct facade namespaces reached | 13 |

The narrowness is an artifact of where the type is *named*, not of what is *used*. Making the four
generic over the client type pushes the concrete type down into the 26 implementations, turning 4
inversions into up to 26. A port covering 13 namespaces is the whole facade, so it would either
duplicate the public API shape — a second source of truth for it — or derive from the facade and
carry the same dependency.

Those four files are therefore the minimum number of naming sites, not an accident: they are the
choke point. Accepted as a position, argued at `TYPE_INVERSION_BASELINE`. The remaining option is
the one that was always the real question — whether `NAVIGATION_COMMAND_PROJECTIONS` belongs in
`commands/` — and that is a design decision about the command surface, not a dependency cleanup.

## 1. The two remaining type-inversion clusters

`TYPE_INVERSION_BASELINE` in `scripts/layering/check.ts` holds both, with the reasoning inline.

**28 + 1 edges → `client/client-types.ts`** — *done, mostly.* Now 5 edges. The vocabulary moved into
the `contracts/client-*.ts` family files — one file per command/domain family, largest 137 LOC —
with `client/client-types.ts` keeping the `AgentDeviceClient` facade and re-exporting the rest
through one wildcard per family. The published surface is unchanged, verified two ways against
`main`: the exported-name set of all 11 published entrypoints is identical (70 names), and every
declaration in the built `index.d.ts` is byte-identical after normalization (0 names added, 0 shapes
changed). `index.d.ts` in fact got *smaller* — 1,726 → 1,682 lines — because 10 declarations that
`main` duplicated into it (the Metro option/result shapes, `ScrollInputDirection`) now resolve
through a shared chunk once the vocabulary sits below both its consumers.

The mutual coupling this section already warned about is what set the floor. Eight shapes could NOT
move down, because each is stated in terms of a HIGHER-ranked zone:

| Shape(s) | Blocked by |
|---|---|
| `ScrollOptions` | `ScrollInputDirection` (`commands/interaction/runtime/gestures.ts`) |
| `BackCommandOptions`, `OrientationCommandOptions`, `AppSwitcherCommandOptions`, `TvRemoteCommandOptions`, `AgentDeviceCommandClient` | `NavigationCommandOptions` / `ProjectedNavigationCommandClient` (`commands/system/navigation-projection.ts`) |
| `MetroPrepareResult`, `MetroReloadResult` | `PrepareMetroRuntimeResult` / `ReloadMetroResult` (`metro/client-metro.ts`) |

Declaring those in `contracts/` would have traded 28 `commands -> client` inversions for
`contracts -> commands` and `contracts -> metro` ones — the foundation depending on the layers above
it, which is worse in kind even though it is fewer edges. Measured, not assumed: the first attempt
put the whole file in `contracts/` and the gate went from 42 to **48**.

Two keystone moves made the other 84 shapes movable, and both are worth noting as a pattern:

- `RemoteConnectionProfileFields` joined its sibling `CloudProviderProfileFields` in
  `contracts/remote-config-fields.ts`. It was the root of the base chain
  (`AgentDeviceClientConfig` → `AgentDeviceRequestOverrides` → `DeviceCommandBaseOptions` → every
  per-command `*Options`), so one rank-4 declaration was pinning ~80 shapes up with it.
- `DaemonBatchStep` moved to `contracts/batch-step.ts`. Its `runtime` field was written as
  `DaemonRequest['runtime']`, which dragged the whole daemon request type in to say
  `SessionRuntimeHints` — the same type, three zones lower.

**Remaining `commands -> client` (5) needs the upstream declarations to come down first**: move
`ScrollInputDirection` and the navigation-projection types out of `commands/`, and the Metro
prepare/reload result payloads out of `metro/`. Each is small; the sequencing is the point. The
`mcp -> client` edge is different in kind — it is the `AgentDeviceClient` facade itself, i.e. the
question of whether a command surface should know the client type. That is a design decision, not a
misplaced declaration.

**5 + 1 edges → `daemon/daemon-command-registry.ts` and `daemon/types.ts`.** `core`'s descriptor
registry composes the ADR 0003 daemon facet, whose shape the daemon declares. ADR 0003's
daemon-owned-declaration invariant is about the _values_ (route + policy traits), which stay in
`daemon/`; only the shape needs to sit below `core`. `DaemonCommandDescriptor` references the
daemon-internal `DaemonRequest`, so this is a real change, not a file move — either the facet type
becomes generic over the request type, or the request shape itself moves down.

## 2. `daemon/types.ts` is a second contracts module at rank 4

> **Status after #1435:** the inventory below is historical. `SessionAction`, replay-suite results,
> `DaemonLockPolicy`, and the public daemon response/artifact/runtime-hint shapes now live below
> daemon. Four production files outside daemon still import `daemon/types.ts`; two are
> daemon-specific Maestro adapters scheduled to move back under daemon. `DaemonRequest` itself
> intentionally remains server-private because it carries admitted leases, callbacks, replay
> guards, and narrowed flags. Remove the remaining external imports through neutral caller-specific
> contracts; do not move `DaemonRequest` wholesale.

554 lines, **174 dependents, 173 of them type-only**, and 10 of its 15 exported types are imported
from outside `daemon/`: `DaemonRequest` (8), `SessionAction` (7), `ReplaySuiteResult` (6),
`ReplaySuiteTestResult` (4), `DaemonResponse` (2), plus `SessionRuntimeHints`, `DaemonInvokeFn`,
`DaemonResponseData`, `DaemonArtifact`, `DaemonLockPolicy`. Those ten belong in `contracts/` — and
moving `DaemonRequest` is most of what §1's second cluster needs.

## 3. `(root)`: what is left is there for a reason

13 files: 11 published `package.json` entrypoints, the three executables (`bin.ts`, `cli.ts`,
`daemon.ts`), and the composition roots — `runtime.ts`, `agent-device-client.ts`,
`provider-device-runtime.ts`, `command-catalog.ts`.

The composition roots cannot join the spine, and the reason is worth recording: **R2
(commands-floor) forbids `daemon/` from importing `commands/`**, so anything that wires the command
surface into the daemon must sit outside the spine. `runtime.ts` imports `commands/index.ts` and is
consumed by five daemon files; that is exactly what `UNRANKED_ZONES`' "compose the spine from
above" means. Two remain awkward:

- `command-catalog.ts` (42 lines, 45 dependents in 7 zones) is a pure projection of
  `core/command-descriptor/registry.ts`, so `core/` is its natural home — but
  `platforms/apple/plugin.ts` and `platforms/vega/plugin.ts` import `PUBLIC_COMMANDS` to key their
  `Record<string, (device) => boolean>` default-support maps, and `platforms` is rank 1. Moving the
  catalog to `core/` would create two real back-edges. The ADR-0008-aligned fix is the other
  direction: those per-command support maps are the _descriptor's_ capability facet, so the
  platform plugins should not be naming commands at all.
- `provider-device-runtime.ts` (338 lines) is imported by `core/interactors.ts` at value level and
  itself needs `daemon/lease-registry.ts` and `daemon/handlers/lease.ts` at value level. It is a
  genuine composition root; ranking it would require splitting the provider lookup from the lease
  wiring.

## 4. Eight cycles the gate does not reject — seven type-only, one dynamic

R4 covers static value edges only, by design.

```
[type]    backend.ts -> commands/command-input.ts -> client/client-types.ts
          -> commands/interaction/runtime/gestures.ts -> runtime-contract.ts -> backend.ts
[type]    cloud-webdriver/aws-device-farm-artifacts.ts <-> cloud-webdriver/aws-device-farm.ts
[type]    cloud-webdriver/capabilities.ts <-> cloud-webdriver/runtime.ts
[type]    commands/batch/index.ts -> commands/batch/projection.ts
          -> commands/command-projection.ts -> commands/batch/index.ts
[type]    daemon/device-claim-inspection.ts <-> daemon/device-claims.ts
[type]    platforms/android/adb-executor.ts <-> platforms/android/snapshot-helper-types.ts
[type]    platforms/web/agent-browser-lifecycle.ts <-> agent-browser-tool.ts
[dynamic] platforms/apple/os/macos/audio-probe.ts <-> platforms/audio-probe-backend.ts
```

The five mutual pairs are all the same shape — two modules co-defining one contract — and all have
the same one-line fix: a third module holding the shared type. The 5-node loop closes through
`backend.ts` (root, 21 type-only dependents across 5 zones) reaching _up_ into
`commands/command-input.ts`; it will not close once §1's first cluster is done.

## 5. `daemon-server`: where the size actually comes from

219 files / 46 550 lines — 25% of `src/`, at rank 4. `daemon/handlers/` is 102 files / 24 292
lines in one flat directory whose _names_ carry a hierarchy the filesystem does not: 61 `session-*`
(14 723 lines), 16 `interaction-*`, 13 `record-*`, 5 `snapshot-*`. `daemon/` itself is another 103
flat files.

Things that are **not** wrong, checked and ruled out:

- **No copy-paste.** Zero 7-line windows repeat across three or more daemon files.
- **The two error conventions converge.** 202 `errorResponse(...)` sites sit beside 64 thrown
  `AppError`s, and a probe through the real router confirmed both reach the wire with the same
  `hint`, `diagnosticId` and `logPath` — `finalizeDaemonResponse` rebuilds every returned failure
  into a fresh `AppError` and re-normalizes it. The cost is that shim (whose own comment records a
  bug where it dropped `retriable`/`supportedOn`) and the `Response | Failure` unions it forces
  through every helper signature, not a behavioural gap. They are _not_ interchangeable, though:
  the same probe showed the returned and thrown paths write **different session events**, so
  converting one to the other is a behaviour change, not a cleanup.
- **The ADR 0008 projection landed.** `DAEMON_COMMAND_DESCRIPTORS` is derived from the core
  descriptors; the "copied VERBATIM from daemon" comment in `core/command-descriptor/registry.ts`
  is a stale migration note, not live duplication.

### 5a. `SessionState` is store-owned mutable state — now with declared owners

`SessionStore.get()` returns the live object out of a private `Map`; `set()` re-puts the same
reference. So the 57 direct `session.<field> = …` writes across 17 files are durable whether or
not `set()` follows, which makes the 26 `set()` calls ceremonial — they document intent rather
than committing anything. Both methods now say so in their own doc comments.

Measuring which module writes which field showed the problem is narrower than the raw count: **16
of 27 fields already have exactly one writer**. The sharp case was ADR 0014's ref frame —
`refFrameState`, `refFrameScope`, `refFrameTree`, `refFrameGeneration` must move together or the
frame is incoherent, yet complete issuance wrote them in `ref-frame.ts` and partial issuance
wrote the same four in `session-snapshot.ts`, even though `ref-frame.ts` claims in its header to
be "the single owner of the frame's transitions". Both forms now go through `activateRefFrame`.

`recordSession` deliberately moves alone in two paths (recording without arming a publication),
so the save-script cluster got no invented abstraction. It got ownership: **R7** records every
field's owner in `SESSION_STATE_FIELD_OWNERS` and stops the set growing quietly — a new field
must declare an owner, a foreign write fails naming the owner to call, and an owner that stops
writing must be removed so the table cannot drift into fiction.

### 5b. 88 platform-conditional sites, in the layer ADR 0009 exists to keep neutral

`daemon-server` holds 88 `platform === '…'` / `switch (platform)` / `isApple*()` sites — more than
`platforms/` itself (48) — against a plugin contract whose own doc says "The plugin's only job is
to stop core/daemon from BRANCHING on platform." Four facets are live (`appLog`, `recording`,
`perf`, provider gating); the branch count says the mechanism is right and unfinished. Worst
offenders: `handlers/session-perf.ts` (12), `handlers/session-doctor-device.ts` (6),
`handlers/session-replay-maestro-runtime.ts` (6), `handlers/session-state.ts` (5). Each is a
candidate facet, and each facet retired is a branch deleted in every command that shares it.

### 5c. Redundant edges: hub concentration, not debt

1333 of 3147 value edges (42%) are transitively redundant, 1115 through a single intermediate hop.
**This is not a defect list** — importing `kernel/errors.ts` directly is clearer than inheriting it
through a sibling. It earns its keep per file: `daemon/server/daemon-runtime.ts` gets 18 of its 32
imports from one neighbour, `handlers/session-open.ts` 17 of 30, `handlers/session.ts` 17 of 32,
`handlers/find.ts` 16 of 20. A file whose neighbour already provides two-thirds of what it imports
is usually doing its neighbour's job too — the same orchestrator smell as §5, from the other side.

## 6. R2 is right, and the duplication it forces now has a home

R2 (commands-floor) forbids `kernel`/`platforms`/`core`/`daemon` from importing `commands/`.
Measured, that is not an arbitrary restriction but the shape of the system: `commands/` is
consumed only by `cli/` (9), `cli-schema/` (9), `mcp/` (16), `client/` (2) and the composition
roots (7). It is the client-side surface; the daemon is the executor on the other side of the
wire, and ADR 0008 protects exactly that seam ("the process boundary is never collapsed").
Relaxing R2 would let the executor depend on a client projection and pull CLI grammar and output
formatting into the daemon's bundle.

The duplication is real, though, because the daemon must validate independently — it accepts
requests from any client — so the only place a shared rule can live is below both zones.
`selectors/` already held the parsers (`splitIsSelectorArgs`, `splitSelectorFromArgs`,
`isSupportedPredicate`) and even the `is` predicate message; it just did not hold the checks that
use them. It does now: `checkFindArgs`, `checkIsPredicate`, `checkIsArgs`, `checkGetFormat`,
`checkElementTargetArgs`, `checkWaitText`. Each reports a refusal and leaves the mechanism to the
caller, because returning and throwing are **not** interchangeable — they write different session
events.

Three drifts had already appeared in the `is` predicate rule alone, which is the argument for
doing this rather than leaving the copies aligned by hand:

- `commands/interaction/selectors.ts` re-implemented the predicate list as an inlined seven-way
  `!==` chain while importing the message and hint from `selectors/predicates.ts`, so adding a
  predicate to the shared list would not have reached the CLI grammar.
- That chain compared the raw token, so the CLI rejected `is TEXT …` while the daemon it hands
  the command to accepts it.
- `isCommand` raised the same refusal without `IS_PREDICATE_USAGE_HINT`, so whether an agent got
  recovery guidance depended on which layer noticed first — the failure mode ADR 0010's audit
  calls out.

Still duplicated across zones, each needing the same treatment: `fill requires text` /
`type requires text` (`commands/interaction/runtime/interactions.ts` ↔
`core/dispatch-interactions.ts`), `open <app> <url> requires a valid URL target` and
`settings clear-app-state requires an app id…` (`core/dispatch.ts` ↔ two platform modules), and
`snapshot is not supported by this backend` (three files inside `commands/`).

## 7. `eslint-plugin-boundaries` under oxlint: evaluated, works, not adopted

Spiked properly (installed, configured against the real tree, verified by injection) so nobody has
to repeat it. **It runs** — oxlint's `jsPlugins` loads npm ESLint plugins directly, so this needs no
ESLint install, no second config and no extra CI step:

```json
{ "jsPlugins": [{ "name": "boundaries", "specifier": "eslint-plugin-boundaries" }] }
```

R1, R2 and R3 are all expressible, and all three were confirmed to fire on injected violations while
every documented exemption held. The two non-obvious settings that make R3 work:

| need | mechanism |
|---|---|
| ignore type-only edges | `importKind: "value"` on the policy |
| ignore dynamic `import()` | `settings["boundaries/dependency-nodes"] = ["import", "export"]` |

**Why we did not adopt it.** None of these is fatal alone; together they lose more than the
declarative syntax gains, and `ZONE_POLICIES` gets that syntax anyway:

- **No ratchet.** The mechanism that took R6 from 61 → 7 across three PRs is a baseline that
  tolerates N and fails on N+1. A per-file lint rule has no cross-run aggregate, so it cannot do
  this. Any new boundary with existing violations — the platforms facade has ~89 — would need one
  disable comment per site.
- **It cannot replace the gate.** R4 (cycles), R5/R6 (spine ranking + ratchet), R7 (field
  ownership — not an import rule at all) and R9 (cycle size) are whole-graph or non-import
  properties. Adopting it means R1-R3 live in one system and R4-R9 in another, so
  "where is our architecture defined" gets two answers.
- **Inline type specifiers are misread.** `import { type A, type B } from '…'` is fully erased at
  runtime, but the plugin classifies it as a value import (its `importKind` is statement-level).
  That produced one real false positive here — `providers/limrun/android.ts` — flagged as an R3
  violation the gate correctly ignores. Only 10 of 1,481 type-only edges use this form, so the blast
  radius is small, but `statementIsTypeOnly` in `model.ts` handles both spellings and the plugin
  does not.
- **Message specificity regressed.** With the current non-deprecated selector syntax,
  `{{dependency.type}}` and `{{file.type}}` interpolated to empty strings, so violations read
  `must not import commands/` with no zone named. ADR 0010 wants every error actionable.
- **Cost.** 230 transitive packages, and `jsPlugins` is documented as "in alpha and not subject to
  semver." A single config attempt produced five deprecation warnings (`mode`, `rules`, legacy
  selectors, legacy templates, rule-level `importKind`) spanning two major migrations.

Worth re-evaluating if the monorepo migration happens — per-package ESLint configs change the
calculus — or once `jsPlugins` is stable and the ratchet gap is addressable.

## Terminal current-state note

The measurements and R3 experiment above are historical audit evidence, not the current layering
contract. After #2082, `src/platforms/` is retired: family implementations and family-owned tests
live in their workspace packages, while the shared install-source tests live under
`src/__tests__/`. Package-level R13 owns platform exports and consumer seams, R65 owns the daemon's
complete concrete-platform ban, and `retired-platforms-zone` rejects every tracked file under the
old path. Legacy `src/platforms` spellings remain only in deliberate negative fixtures and
implementation-pattern checks so reintroduction fails closed.

## Suggested order from here

1. ~~**Move the 10 outward-facing `daemon/types.ts` types into `contracts/`** (§2).~~ Mostly
   completed by #1435. Eliminate the four remaining external production importers with
   caller-specific public contracts or daemon-owned adapters; keep `DaemonRequest` private.
2. ~~**Split `client/client-types.ts`** (§1).~~ Done — 42 → 18 total inversions. The follow-up is
   the upstream moves that unblock the last 5 (§1): `ScrollInputDirection` and the
   navigation-projection types out of `commands/`, Metro result payloads out of `metro/`.
3. **Retire platform branches into plugin facets** (§5b), highest-count files first.
4. **Share the remaining duplicated validators** (§6), following the `checkIsArgs` shape.
5. Optional: give `daemon/handlers/` the directory structure its filenames already imply (§5).
