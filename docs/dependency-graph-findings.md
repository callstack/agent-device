# Dependency graph findings

Snapshot analysis of the production import graph — 894 files, 4619 edges, 25 zones — taken while
doing the boundary work in this branch. It is a dated observation, not a normative document; when
it disagrees with `scripts/layering/`, the gate wins.

The graph tool that produced it lives on the `claude/depgraph-viewer` branch (`pnpm depgraph`),
deliberately kept out of this change so the refactor stands on its own.

## Where this round landed

|                                                          | before                 | after                                           |
| -------------------------------------------------------- | ---------------------- | ----------------------------------------------- |
| type-only spine inversions (R6)                          | 61 across 6 zone pairs | **35 across 4**, ratcheted                      |
| files in the unranked `(root)` zone                      | 29                     | **13** — entrypoints and composition roots only |
| files covered by the ranked spine                        | 651 of 892             | **729 of 894**                                  |
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

## 1. The two remaining type-inversion clusters

`TYPE_INVERSION_BASELINE` in `scripts/layering/check.ts` holds both, with the reasoning inline.

**28 + 1 edges → `client/client-types.ts`** (1236 lines). The file does three jobs: the public
Node-client facade (`AgentDeviceClient`, config, transport), the per-command `*Options`/`*Result`
vocabulary that `commands/`, `contracts/` and `mcp/` all need, and a re-export hub for 24
`contracts/` types. Only the first is client-owned. The fix is the pattern the file already uses
for those 24 re-exports: declare the command I/O vocabulary in `contracts/` and re-export it here,
so the public surface stays byte-identical. Note the coupling is mutual — client-types imports
`commands/interaction/runtime/gestures.ts` and `commands/system/navigation-projection.ts` — which
is what closes the 5-node type cycle in §4. This is also the deferred "Node client result types"
work `CONTEXT.md` already tracks.

**5 + 1 edges → `daemon/daemon-command-registry.ts` and `daemon/types.ts`.** `core`'s descriptor
registry composes the ADR 0003 daemon facet, whose shape the daemon declares. ADR 0003's
daemon-owned-declaration invariant is about the _values_ (route + policy traits), which stay in
`daemon/`; only the shape needs to sit below `core`. `DaemonCommandDescriptor` references the
daemon-internal `DaemonRequest`, so this is a real change, not a file move — either the facet type
becomes generic over the request type, or the request shape itself moves down.

## 2. `daemon/types.ts` is a second contracts module at rank 4

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

## Suggested order from here

1. **Move the 10 outward-facing `daemon/types.ts` types into `contracts/`** (§2). Mechanical, and
   it clears most of §1's second cluster.
2. **Split `client/client-types.ts`** (§1). Largest remaining inversion cluster, closes the 5-node
   type cycle, and it is already-tracked deferred work.
3. **Retire platform branches into plugin facets** (§5b), highest-count files first.
4. **Share the remaining duplicated validators** (§6), following the `checkIsArgs` shape.
5. Optional: give `daemon/handlers/` the directory structure its filenames already imply (§5).
