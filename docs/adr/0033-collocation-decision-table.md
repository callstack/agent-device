# 0033. Collocation decision table

Status: accepted. Decision pass over the 48 candidate files listed in umbrella issue #3276 §5
(communities detected at `ff685ad80`: declared zones score 0.373 Louvain modularity versus 0.564
for detected communities). One row per candidate: `move`, `merge`, or `keep`, with the reason.
Moves land as `refactor(move)` PRs; batch 1 is the companion PR to this decision.

## Rules at a glance

- A `keep` row is a decision, not a punt: the reason names the direction that was checked and why
  it fails (usually a package cycle or a spine inversion).
- The detected community is not itself a reason to move. Most candidates sit in a consumer's
  community precisely because they are shared foundations; the table records where the module
  **can** live, which is often where it already lives.
- Moves only count when the target has a real seam: no new dependency direction, no root
  composition pulled into a package, and the file's own imports come along unchanged. Where the
  proposal was infeasible, the row records that, and no issue is filed to re-propose it.
- A path-keyed rule (R13's importer lists, R76's inventory, R78's scope) describes today's seam,
  not proof that a placement is best. A row whose only evidence is such a rule says
  "retain for this batch — relocation requires coordinated ownership changes" instead of resting
  the placement on the rule's path. A package cycle rejects the proposed direction, not every
  future design that first removes the edge closing it.
- Rows marked `move (batch N)` are tracked as unchecked items on #3281; batch 1 is this decision's
  companion `refactor(move)` PR.

## Decision table

### capture-kit

| File | Decision | Reason |
| --- | --- | --- |
| `src/capture-admission/audio-probe-admission-ledger.ts` | keep (proposed move rejected) | The proposed → managed-allocation move would add a capture-kit→managed-allocation edge while `managed-allocation` already depends on `capture-kit`, completing a package cycle (R4). That rejects this direction; a future design that first removes the edge closing the cycle (e.g. moving the record codec off capture-kit) is not excluded by this row. |
| `src/capture-admission/durable-capture-admission-ledger.ts` | keep (proposed move rejected) | Same rejected direction: it is the generic engine the three per-resource ledgers specialize, consumed by `durable-capture-resource.ts` and `durable-capture-start-preflight.ts` inside capture-kit. |
| `src/capture-admission/perf-capture-admission-ledger.ts` | keep (proposed move rejected) | Same rejected direction; a four-line specialization of the ledger its own package owns. |
| `src/capture-admission/screen-recording-admission-ledger.ts` | keep (proposed move rejected) | Same rejected direction; consumed by capture-kit's screen-recording session resource and stop-recovery. |
| `src/durable-json.ts` | keep (proposed move rejected) | `managed-allocation` already imports this module from capture-kit, so the proposed direction cannot reverse without completing a package cycle; a design that removes that import first stays open. Considered a contracts home beside `json.ts` and rejected on ownership grounds: contracts is wire vocabulary (R18), not durable-descriptor validation mechanics. The coupling the community saw is the three managed-allocation `record-*` consumers; they can stay. |
| `src/snapshot/snapshot-evidence.ts` | keep | Snapshot-capture mechanics; the daemon-dominated community is consumer-side, and moving it into daemon-server would force every platform and provider onto the daemon zone for capture evidence. |
| `src/snapshot/snapshot-freshness/index.ts` | keep | Same: platform-neutral freshness policy its consumers (capture-kit itself, platforms, daemon) all import downward today. |
| `src/snapshot/touch-reference-frame.ts` | keep | Snapshot-geometry mechanics used by interaction and capture alike; capture-kit is the only zone below both. |

### contracts

contracts is the rank-1 shared-vocabulary zone. Each candidate below that stays has dependents in
two or more higher-ranked zones, so no single consumer zone can own it without inverting the spine
(R5). The one move row is the counter-case: its dependents all sit in one consumer zone that
already owns the operations behind the vocabulary.

| File | Decision | Reason |
| --- | --- | --- |
| `src/android-observation.ts` | keep | Vocabulary read by capture-kit, platform-android, and daemon-server; contracts is the only zone below all three. |
| `src/android-system-chrome.ts` | keep | Same three-way split (capture-kit, platform-android, daemon-server). |
| `src/app-events.ts` | keep | Event vocabulary shared by commands, daemon, and platforms. |
| `src/app-state.ts` | keep | Broad fan-in app-state vocabulary; any consumer-side home would rank it above the others. |
| `src/device-boot.ts` | keep | Boot-phase vocabulary for device-selection, platforms, and daemon-server. |
| `src/facades/device.ts` | keep | Published facade of the contracts package; facades are the package boundary, not movable content. |
| `src/interaction-guarantees.ts` | keep | AGENTS.md names this file as the declaration site for interaction dispatch paths and guarantee cells (ADR 0011); the cross-language golden tables under `contracts/fixtures/` bind it to this package. |
| `src/managed-device-allocation.ts` | move (batch 1) → `packages/managed-allocation` | The port and its vocabulary ([ADR 0021](0021-host-simlock-managed-device-allocation.md) §3) are consumed only by managed-allocation and the daemon composition that already depends on that package; no other contracts file or zone imports it, so the types land beside the operations that implement them. |
| `src/wait-runtime-plan.ts` | keep | Shared by command-registry and daemon-server; both are spine zones and contracts is the only seam below them. |

### device-selection

| File | Decision | Reason |
| --- | --- | --- |
| `src/device-inventory-context.ts` | keep | Rank-1 selection engine imported by daemon-server, remote, and replay adapters; the daemon-heavy community is its largest consumer, not its owner. |
| `src/device-selection-resolver.ts` | keep | Same — moving it up would rank it above its other consumers (replay-port, cli). |
| `src/dispatch-resolve.ts` | keep | Dispatch resolution is shared by the daemon gateway and the daemonless CLI paths; only the rank-1 zone sits below both. |
| `src/open-target.ts` | keep | Open-target vocabulary consumed across daemon, remote, and CLI. |

### host-kit

| File | Decision | Reason |
| --- | --- | --- |
| `src/diagnostics.ts` | keep | The diagnostics seam every zone imports (AGENTS.md mandates it); highest fan-in in the repo is what a substrate looks like, not misplacement. |
| `src/internal/request-cancel.ts` | keep | Request-cancellation mechanics AGENTS.md routes to `host-kit/request`; internal beside its facade is already the collocation. |
| `src/request.ts` | keep | Cross-layer request contracts AGENTS.md names as a host-kit seam; consumers span every zone. |
| `src/session-paths.ts` | keep | Session-artifact path grammar the daemon, cli, and platforms all resolve; AGENTS.md keeps the path *policy* in `src/daemon/session-artifact-paths.ts`, which consumes this. |

### kernel

| File | Decision | Reason |
| --- | --- | --- |
| `src/device-isolation.ts` | keep | Device-isolation vocabulary below device-selection, replay-port, and daemon; kernel is the only zone beneath all of them. |

### platform-android

| File | Decision | Reason |
| --- | --- | --- |
| `src/device-boot.ts` | keep | Boot mechanics the platform owns per ADR 0019/R13; the root-zone consumers are the composition root loading its own platform packages. |

### platform-apple

| File | Decision | Reason |
| --- | --- | --- |
| `src/runner-owner-facade.ts` | keep | ADR 0005 runner-owner seam; R13 owns the platform package's composition exports and the root importer is the designated host. |
| `src/runner/legacy-xctest-device-set.ts` | keep | Runner-internal legacy device-set parsing beside the runner it serves. |
| `src/simulator-boot.ts` | keep | Simulator boot mechanics are platform authority (ADR 0009); the kernel device model and xctestrun preparation must stay in sync with it in this package. |

### replay-port

| File | Decision | Reason |
| --- | --- | --- |
| `src/daemon-port/session-test-shard-devices.ts` | keep | Already collocated: it is the daemon-port adapter binding shard enumeration, and `replay-test` (the scheduler) deliberately never enumerates hardware — moving it toward that zone would break the port. |

### selectors

| File | Decision | Reason |
| --- | --- | --- |
| `src/parameterized-recorded-fill.ts` | keep | ADR 0017 recorded-input mechanics; selector parsing/matching is centralized in this package by AGENTS.md. |
| `src/target-evidence.ts` | keep | Target-evidence vocabulary shared by daemon replay and selectors matching; selectors is below both. |

### cli

| File | Decision | Reason |
| --- | --- | --- |
| `src/cli/commands/device-release.ts` | keep | Command surface belongs in `cli` by the folder spine; the daemon device-claim modules it reuses are already extracted, so what remains is thin daemonless-CLI composition. |

### (root)

`#3288` assigns every process-root module a logical zone in
`scripts/layering/root-module-zones.ts` (`daemon-contracts` rank 2, `command-runtime` rank 3,
`platform-runtime` rank 4, …) while leaving the files physically in place. Per the maintainer
design decision, that reclassification is **not** completed collocation: the physical moves under
#3294 (child of #3276) replace each file's row with folder-derived ownership.
`daemon-diagnostics-scope.ts` has moved into `src/daemon-contracts/`; the runtime assembly pair
`runtime-command-surface.ts` / `runtime-factory.ts` has moved into `src/command-runtime/`.
The other rows below are keeps: the
daemon ⇄ client shared files (`daemon-policy-file.ts`, `provider-credential-fingerprint.ts`,
`request-progress-protocol.ts`) trace to #2559, which relocated the shared contracts **to the
process root** so the client stops importing `src/daemon/` at all; R78 keeps any client→daemon
edge at zero runtime and a five-line recorded type-only residue, and #3288's `daemon-contracts`
zone is the declaration of that shared-below-both ownership. Rows on path-keyed evidence alone
(the `platform-runtime-*` seams) say "retain for this batch": a guard's current path lists
constrain a relocation, they are not independent proof the placement is optimal.

| File | Decision | Reason |
| --- | --- | --- |
| `src/daemon-diagnostics-scope.ts` | moved → `src/daemon-contracts/daemon-diagnostics-scope.ts` ([#3297](https://github.com/callstack/agent-device/pull/3297)) | Physical move landed: the helper now lives under the folder that derives its `daemon-contracts` zone, so `topFolder` replaces the per-file `ROOT_MODULE_ZONES` row and an internal rename needs no ownership-table edit. |
| `src/daemon-policy-file.ts` | keep | Daemon ⇄ client shared contract from #2559, declared `daemon-contracts` by #3288 — the shared-below-both ownership the spine needs, since daemon-client (rank 5) dynamically imports it. |
| `src/daemon.ts` | keep | Entry point (`internal/daemon` bundle entry); composition roots stay in root by umbrella §4. |
| `src/platform-runtime-apple-runner-owner.ts` | retain for this batch | `platform-runtime-*` composition seam: R13's exact-importer rule and the ADR 0022 R76 inventory key on its path, so relocation requires coordinated ownership changes to both declarations — the rules constrain the move, they do not independently prove the placement. |
| `src/platform-runtime-daemon-lifecycle.ts` | retain for this batch | Same path-keyed R13/ADR 0022 seam: relocation is possible only with coordinated changes to those declarations. |
| `src/platform-runtime-device-boot.ts` | retain for this batch | Same path-keyed R13/ADR 0022 seam. |
| `src/platform-runtime-resource-cleanup.ts` | retain for this batch | Same path-keyed R13/ADR 0022 seam. |
| `src/provider-credential-fingerprint.ts` | keep | Daemon ⇄ client shared contract from the same #2559 decision as `daemon-policy-file.ts`; #3288 declares its zone beside the provider composition that reads the credentials it fingerprints. |
| `src/provider-limrun-runtime.ts` | keep | Proposed → provider-limrun, but there is no seam: the class's constructor self-builds the root dependency factory (`src/sdk/limrun-runtime-dependencies.ts`), which is the ADR 0019 composition seam — it loads the root's adb-host binder, core Android interactor, and platform-runtime app-state helpers that the package must not import. Moving the class means moving that composition, which is design, not a move. |
| `src/request-progress-protocol.ts` | keep | Daemon ⇄ client shared contract from the same #2559 decision — the client reads it statically (`daemon-client-progress.ts`) and the server through `src/daemon/server/`, so only #2559's shared-placement boundary and the wire-compat ledgers pin it; declared `daemon-contracts` by #3288. Contracts was considered and R18 keeps contracts free of envelope validation mechanics. |
| `src/runtime-command-surface.ts` | moved → `src/command-runtime/runtime-command-surface.ts` ([#3299](https://github.com/callstack/agent-device/pull/3299)) | Physical move landed with `runtime-factory.ts` as one assembly group: the command-surface binding sits beside the factory it composes, under the folder that derives its `command-runtime` zone, so `topFolder` replaces the per-file `ROOT_MODULE_ZONES` row. |
| `src/runtime-factory.ts` | moved → `src/command-runtime/runtime-factory.ts` ([#3299](https://github.com/callstack/agent-device/pull/3299)) | Physical move landed: the runtime assembly now lives under the folder that derives its `command-runtime` zone, with the same row deletion through folder-derived ownership. |

### sdk

| File | Decision | Reason |
| --- | --- | --- |
| `src/sdk/limrun.ts` | keep | The published `agent-device/limrun` facade: `tsdown.config.ts` builds it as the bundle entry and `package.json#exports` ships `dist/src/limrun.js`. A published facade cannot live in a private workspace package. |
| `src/sdk/limrun-runtime-types.ts` | keep | The public session-type refinement (provider session with the platform `AndroidAdbProvider` types swapped in) exists precisely because the published surface differs from the package-internal one, whose identical names it `Omit`s. Relocating it into provider-limrun requires renaming or dual-exporting the internal types — design, not a move. |

## Batch 1 (this decision's companion PR)

- `packages/contracts/src/managed-device-allocation.ts` → `packages/managed-allocation/src/managed-device-allocation.ts`
  (new `@agent-device/managed-allocation/managed-device-allocation` subpath).

Batch 1 is exactly this one file. The moves the issue listed beside it failed re-verification
against the current import graph, and the rows above record why: the four admission ledgers and
`durable-json.ts` hit the capture-kit ⇄ managed-allocation package cycle, and the three limrun
files have no seam (published facade, public-type collision, root dependency factory).

## Follow-ups (tracked on #3281)

- Physical root-pass moves under [#3294](https://github.com/callstack/agent-device/issues/3294)
  (child of #3276): `daemon-diagnostics-scope.ts` has moved into `src/daemon-contracts/`
  ([#3297](https://github.com/callstack/agent-device/pull/3297)); the runtime assembly pair
  `runtime-command-surface.ts` / `runtime-factory.ts` is collocated in `src/command-runtime/`
  ([#3299](https://github.com/callstack/agent-device/pull/3299)). Each folder derives its zone,
  replacing the moved files' `ROOT_MODULE_ZONES` rows; #3288's zone assignments alone were
  classification, and each landed move completes its own file's collocation.

## Refuted alternatives

- **Move every ≥80% community match into its dominant zone.** Rejected: the measure is
  consumer-side. Foundations (host-kit, contracts, selectors, device-selection) score badly by
  construction, and reversing their edges inverts the spine.
- **`durable-json.ts` → contracts.** Pure-JSON helpers looked like `contracts/json.ts` neighbors,
  but R18 holds contracts to wire vocabulary, and these functions are durable-descriptor
  persistence validation. Rejected.
- **Ledgers → managed-allocation with capture-kit importing them back.** Rejected as proposed: it
  completes the cycle that R4/R11 reject while managed-allocation's dependency on capture-kit is
  load-bearing (its record codec uses capture-kit durable mechanics). Removing that load-bearing
  import first would reopen the question — this row refuses the sequence, not the destination.

## The enduring rule

Collocation is judged by ownership: the placement that minimizes independently maintained
declarations per change. Dependency-community scores only identify candidates; a guard's current
path lists (R13, R76, R78) are constraints a relocation must account for, never independent
evidence that a location must stay. A keep that cannot cite ownership, only a path, is marked
"retain for this batch" so the next pass re-opens it rather than inheriting it as settled.
