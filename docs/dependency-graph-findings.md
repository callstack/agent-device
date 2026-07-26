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
| value-import cycles (R4) / spine back-edges (R5)         | 0 / 0                  | 0 / 0                                           |

What moved: the platform-plugin contract and its four facet tags, `NetworkEntry`, the
click-button / recording-export-quality / interactor-types / runner-lease-context vocabularies,
and 16 internal modules out of `(root)`; `utils` joined the spine at rank 1 after its two upward
files moved to the zones they were reaching for. R6 now ranks type-only edges so the remaining 35
can only shrink.

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

### 5a. `SessionState` is store-owned mutable state, mutated from 17 files

`SessionStore.get()` returns the live object out of a private `Map`; `set()` re-puts the same
reference. So:

- **57 direct `session.<field> = ...` writes across 17 files** outside `session-store.ts` —
  `session-snapshot.ts` (8), `handlers/session-replay-runtime.ts` (7), `ref-frame.ts` (6),
  `handlers/session-close.ts` (5), `session-action-recorder.ts` (5), …
- **77 `sessionStore.get()` calls in 39 files**, but only **26 `set()` calls in 17**. The gap is
  the tell: mutations persist through aliasing, so the 26 `set()` calls are ceremonial and the
  read-modify-write pattern is really direct mutation of store-owned state.

This is the largest structural item in the daemon. Invariants that ADR 0014 (ref-frame lifetime)
and the snapshot generation counter depend on are enforced in whichever of those 17 files
remembered to; nothing at the store boundary can check them; and any future change to
`SessionStore` — persistence, cloning, the ADR 0018 journal reading session state — breaks silently
because whether a write is durable depends on aliasing rather than on the API. The shape of the
fix is intent-named mutators on `SessionStore` (`markRefsIssued`, `recordSnapshot`,
`attachPerfRun` — `markSessionPartialRefsIssued` already shows the pattern), `get()` handing back
a readonly view, and a gate rule in the R1–R6 style forbidding `session.<field> =` outside the
store. It is measurable end to end: 57 → 0.

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

## 6. Duplicated validation, forced by R2

20 distinct error messages are constructed in more than one zone; 10 of those pairs are
`commands ↔ daemon-server`. That duplication is **structural, not sloppiness**: the daemon must
validate independently (it accepts requests from any client over HTTP/JSON-RPC), and R2 forbids it
from importing `commands/`. So the only way to share a rule is to declare it below both.

`find` is now the worked example: `checkFindArgs` lives in `selectors/find.ts` beside
`parseFindArgs` and `isReadOnlyFindAction`, and both daemon entry points call it — the copy in
`dispatchFindReadOnlyViaRuntime` was also unreachable, since its only caller validates first. The
remaining pairs, each needing the same treatment:

| message                                                                                                                                                                          | zones                                                                                                            |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `get requires @ref or selector expression`, `get only supports text or attrs`, `is requires a selector expression`, `is text requires expected text value`, `wait requires text` | `commands/cli-grammar/common.ts`, `commands/interaction/runtime/selector-read.ts` ↔ `daemon/selector-runtime.ts` |
| `find did not match any element`, `find could not read the current accessibility tree`                                                                                           | `commands/interaction/runtime/selector-read.ts` ↔ `daemon/handlers/find.ts`                                      |
| `fill requires text`, `type requires text`                                                                                                                                       | `commands/interaction/runtime/interactions.ts` ↔ `core/dispatch-interactions.ts`                                 |
| `open <app> <url> requires a valid URL target`, `settings clear-app-state requires an app id…`                                                                                   | `core/dispatch.ts` ↔ `platforms/android/settings.ts`, `platforms/apple/core/app-settings.ts`                     |
| `snapshot is not supported by this backend`                                                                                                                                      | three files inside `commands/`                                                                                   |

## Suggested order from here

1. **`SessionState` mutators + a gate rule** (§5a). Biggest structural item, measurable, and it
   protects ADR 0014's invariants.
2. **Move the 10 outward-facing `daemon/types.ts` types into `contracts/`** (§2). Mechanical, and
   it clears most of §1's second cluster.
3. **Split `client/client-types.ts`** (§1). Largest single inversion cluster, closes the 5-node
   type cycle, and it is already-tracked deferred work.
4. **Retire platform branches into plugin facets** (§5b), highest-count files first.
5. **Share the remaining duplicated validators** (§6), following the `checkFindArgs` shape.
6. Optional: give `daemon/handlers/` the directory structure its filenames already imply (§5).
