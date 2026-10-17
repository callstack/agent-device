# 0033. Collocation decision table

Status: accepted.
This decision evaluates the 48 candidate files in umbrella #3276 §5.
At `ff685ad80`, declared zones score 0.373 Louvain modularity, compared with 0.564 for detected communities.
Each candidate has a `move`, `merge`, or `keep` decision with rationale.
Moves use `refactor(move)` PRs.
Git history retains completed move batches.

The allocator design withdrawal removed `packages/managed-allocation` on 2026-10-10; see [ADR 0021](0021-host-simlock-managed-device-allocation.md).
The `src/managed-device-allocation.ts` row and Batch 1 record a move that landed in #3287.
The removal of the package then deleted the moved file.
Nothing moves there now.
Rows that reject this destination or cite its capture-kit dependency as a cycle no longer bind.
Re-evaluate those files against their remaining edges.

## Rules at a glance

- A `keep` row is a decision, not a deferral.
  Its rationale identifies the examined direction and why it fails, usually a package cycle or spine inversion.
- A detected community does not independently justify a move.
  Most candidates belong to a consumer's detected community because they are shared foundations.
  The table records valid ownership locations, often the existing locations.
- A move counts only when the target has a real seam.
  A real seam means that the move adds no new dependency direction, pulls no root composition into a package, and keeps the file's own imports unchanged.
  If a proposal was infeasible, the row records that.
  No issue is filed to propose it again.
- A path-keyed rule, for example R13's importer lists, R76's path-family ban, or R78's scope, describes today's seam.
  It does not prove that a placement is best.
  If a row has only path evidence, mark it "retain for this batch — relocation requires coordinated ownership changes".
  A package cycle rejects the proposed direction.
  It does not prohibit a future design that first removes the cycle-closing edge.

## Decision table

### capture-kit

| File | Decision | Reason |
| --- | --- | --- |
| `src/capture-admission/audio-probe-admission-ledger.ts` | keep (proposed move rejected) | The proposed move to managed-allocation would add a capture-kit→managed-allocation edge. The reverse dependency already exists, so this forms an R4 package cycle. This rejects the direction, not a future design that first removes the cycle-closing edge. Moving the record codec off capture-kit is one example. |
| `src/capture-admission/durable-capture-admission-ledger.ts` | keep (proposed move rejected) | The same direction is rejected. This generic engine serves three per-resource ledgers. Capture-kit's `durable-capture-resource.ts` and `durable-capture-start-preflight.ts` consume it. |
| `src/capture-admission/perf-capture-admission-ledger.ts` | keep (proposed move rejected) | The same direction is rejected. This file is a four-line specialization of the ledger that its own package owns. |
| `src/capture-admission/screen-recording-admission-ledger.ts` | keep (proposed move rejected) | The same direction is rejected. Capture-kit's screen-recording session resource and stop-recovery consume it. |
| `src/durable-json.ts` | keep (proposed move rejected) | Managed-allocation already imports this capture-kit module. Reversal forms a package cycle unless that import disappears first. A design that first removes that import stays open. Contracts beside `json.ts` was also rejected: under R18, contracts holds wire vocabulary, not durable-descriptor validation mechanics. Three managed-allocation `record-*` consumers explain the community coupling and can remain. |
| `src/snapshot/snapshot-evidence.ts` | keep | This is snapshot-capture mechanics. The daemon-dominated community represents consumers. A daemon-server home would force every platform and provider to depend on the daemon zone for capture evidence. |
| `src/snapshot/snapshot-freshness/index.ts` | keep | The reason for the row above applies. This is platform-neutral freshness policy. All its consumers, capture-kit itself, platforms, and daemon, import it downward today. |
| `src/snapshot/touch-reference-frame.ts` | keep | Interaction and capture share these snapshot-geometry mechanics. Only capture-kit is below both. |

### contracts

Contracts is the rank-1 zone for shared vocabulary.
Each retained candidate has consumers in at least two higher-ranked zones.
A single consumer zone cannot own it without an R5 spine inversion.
The move row is the exception.
All its consumers occupy one zone that already owns the operations represented by its vocabulary.

| File | Decision | Reason |
| --- | --- | --- |
| `src/android-observation.ts` | keep | Capture-kit, platform-android, and daemon-server read this vocabulary. Only contracts is below all three. |
| `src/android-system-chrome.ts` | keep | Capture-kit, platform-android, and daemon-server share this vocabulary. |
| `src/app-events.ts` | keep | Commands, daemon, and platforms share this event vocabulary. |
| `src/app-state.ts` | keep | Many zones consume this app-state vocabulary. Any consumer-side home would place it above other consumers. |
| `src/device-boot.ts` | keep | Device-selection, platforms, and daemon-server consume this boot-phase vocabulary. |
| `src/facades/device.ts` | keep | This is the published facade of the contracts package. Facades are the package boundary, not movable content. |
| `src/interaction-guarantees.ts` | keep | AGENTS.md names this declaration site for interaction dispatch paths and guarantee cells under ADR 0011. Cross-language golden tables in `contracts/fixtures/` bind it to this package. |
| `src/managed-device-allocation.ts` | move (batch 1, landed in #3287; package removed 2026-10-10) → `packages/managed-allocation` | Only managed-allocation and its dependent daemon composition consume this port and vocabulary; see [ADR 0021](0021-host-simlock-managed-device-allocation.md) §3. No other contracts file or zone imports it. Types therefore belong beside their implementing operations. |
| `src/wait-runtime-plan.ts` | keep | Command-registry and daemon-server share it. Both are spine zones; contracts is the only seam below them. |

### device-selection

| File | Decision | Reason |
| --- | --- | --- |
| `src/device-inventory-context.ts` | keep | Daemon-server, remote, and replay adapters import this rank-1 selection engine. The daemon-heavy community is its largest consumer, not its owner. |
| `src/device-selection-resolver.ts` | keep | A higher-ranked home would place it above its other replay-port and cli consumers. |
| `src/dispatch-resolve.ts` | keep | The daemon gateway and daemonless CLI paths share dispatch resolution. Only the rank-1 zone is below both. |
| `src/open-target.ts` | keep | Daemon, remote, and CLI consume this open-target vocabulary. |

### host-kit

| File | Decision | Reason |
| --- | --- | --- |
| `src/diagnostics.ts` | keep | This is the diagnostics seam that every zone imports, as AGENTS.md mandates. Its repository-highest consumer count reflects a shared substrate, not incorrect placement. |
| `src/internal/request-cancel.ts` | keep | AGENTS.md routes request cancellation through `host-kit/request`. Its internal mechanics already reside beside the facade. |
| `src/request.ts` | keep | AGENTS.md names these cross-layer request contracts as a host-kit seam. Consumers span every zone. |
| `src/session-paths.ts` | keep | Daemon, cli, and platforms resolve this session-artifact path grammar. AGENTS.md assigns path policy to `packages/daemon-contracts/src/session-artifact-paths.ts`, which consumes it. |

### kernel

| File | Decision | Reason |
| --- | --- | --- |
| `src/device-isolation.ts` | keep | This device-isolation vocabulary is below device-selection, replay-port, and daemon. Kernel is the only zone below all of them. |

### platform-android

| File | Decision | Reason |
| --- | --- | --- |
| `src/device-boot.ts` | keep | ADR 0019/R13 assign boot mechanics to the platform. The root-zone consumers are the composition root, which loads its own platform packages. |

### platform-apple

| File | Decision | Reason |
| --- | --- | --- |
| `src/runner-owner-facade.ts` | keep | This is the ADR 0005 runner-owner seam. R13 owns the platform package's composition exports. The root importer is the designated host. |
| `src/runner/legacy-xctest-device-set.ts` | keep | Runner-internal legacy device-set parsers reside beside their runner. |
| `src/simulator-boot.ts` | keep | ADR 0009 assigns simulator boot mechanics to the platform. The kernel device model and xctestrun preparation must remain synchronized with them in this package. |

### replay-port

| File | Decision | Reason |
| --- | --- | --- |
| `src/daemon-port/session-test-shard-devices.ts` | keep | This file is already collocated. It is the daemon-port adapter that binds shard enumeration. The `replay-test` scheduler deliberately never enumerates hardware. A move toward that zone would break the port. |

### selectors

| File | Decision | Reason |
| --- | --- | --- |
| `src/parameterized-recorded-fill.ts` | keep | These are ADR 0017 recorded-input mechanics. AGENTS.md centralizes selector parsers and matchers in this package. |
| `src/target-evidence.ts` | keep | Daemon replay and selector matchers share this target-evidence vocabulary. Selectors is below both. |

### cli

| File | Decision | Reason |
| --- | --- | --- |
| `src/cli/commands/device-release.ts` | moved | Its current home is `src/platform-runtime-claim-recovery.ts`. Daemonless stale release composes the shared reconciler with the root gateway. R78 prohibits CLI access to daemon modules. It therefore resides beside the claim-recovery gateway in platform-runtime composition. |

### (root)

#3288 assigns each process-root module a logical zone through `scripts/layering/root-module-zones.ts` without moving files.
Examples are `command-runtime` at rank 3 and `platform-runtime` at rank 4.
The maintainer decision does not classify this as completed collocation.
Physical moves under #3294, a #3276 child, replace per-file declarations with folder-derived ownership.

`runtime-command-surface.ts` and `runtime-factory.ts` now reside in `src/command-runtime/`.
The complete `daemon-contracts` zone resides in `packages/daemon-contracts`, behind narrow per-file subpath exports.
Folders and packages derive these zones, so moved files no longer need `ROOT_MODULE_ZONES` rows.

The remaining shared daemon/client file, `provider-credential-fingerprint.ts`, follows #2559's decision.
That decision moved shared contracts **to the process root** so that the client stops all imports of `packages/daemon/src/`.
The `client-side` logical-module policy prohibits every edge into `packages/daemon/src/` from these consumers:

- CLI.
- Typed client.
- Remote transports.
- `src/daemon-client/`.

R78 also prohibits access through any root module reachable by the CLI process.
#3288's `daemon-contracts` zone declared ownership below both daemon and client.
Package extraction makes it physical.
R11 and package dependencies preserve that boundary.
Rows supported only by path-keyed evidence, the `platform-runtime-*` seams, say "retain for this batch".
A guard's current path lists constrain a relocation.
They are not independent proof that the placement is optimal.

| File | Decision | Reason |
| --- | --- | --- |
| `src/daemon-diagnostics-scope.ts` | moved → `packages/daemon-contracts/src/daemon-diagnostics-scope.ts` ([#3297](https://github.com/callstack/agent-device/pull/3297) into `src/daemon-contracts/`, then the package extraction) | The complete zone resides in `packages/daemon-contracts`. Its directory derives zone ownership without per-file `ROOT_MODULE_ZONES` rows. An internal rename therefore needs no ownership-table edit. |
| `packages/daemon-contracts/src/device-claim-recovery.ts` | keep (shared-below-both) | The owner-scoped claim reconciler recovers durable resources from a dead owner's state directory. Daemon `open`/startup and daemonless `device release --stale` both run it. It therefore belongs below both. Runtime recovery may reside in `daemon-contracts` only when both sides run it and root composition supplies only the gateway, per ADR 0019 section 1. The package depends on `capture-kit`. Capture-kit cannot depend back on it, because that dependency forms a project-reference cycle through `selectors`. |
| `src/daemon-policy-file.ts` | moved → `packages/daemon-contracts/src/daemon-policy-file.ts` | This shared daemon/client contract follows #2559 and #3288's `daemon-contracts` declaration. Rank-5 daemon-client dynamically imports it, so the spine requires a home below both. Package extraction supplies that physical home with manifest-owned exports. |
| `src/daemon.ts` | keep | This is the `internal/daemon` bundle entry. Umbrella §4 keeps composition roots at the root. |
| `src/platform-runtime-apple-runner-owner.ts` | retain for this batch | This is a `platform-runtime-*` composition seam. R13's exact-importer rule and ADR 0022's R76 ban on the `src/platform-runtime-*.ts` family key on its path. Relocation requires coordinated ownership changes to both declarations. The rules constrain the move without independently proving placement. |
| `src/platform-runtime-daemon-lifecycle.ts` | retain for this batch | The same path-keyed R13/ADR 0022 seam applies. Relocation is possible only with coordinated changes to those declarations. |
| `src/platform-runtime-device-boot.ts` | retain for this batch | The same path-keyed R13/ADR 0022 seam applies. |
| `src/platform-runtime-resource-cleanup.ts` | retain for this batch | The same path-keyed R13/ADR 0022 seam applies. |
| `src/provider-credential-fingerprint.ts` | keep (type extracted) | Like `daemon-policy-file.ts`, this shared daemon/client contract follows #2559. #3288 declares its zone beside the provider composition that reads the credentials this file fingerprints. Daemon extraction PR 6 moved only the `DaemonProviderCredentials` declaration to `packages/daemon-contracts` at `./provider-credentials`. This is the same shared-below-both landing as the policy file. The implementation remains here because it reads the installed-plugin manifest. |
| `src/provider-limrun-runtime.ts` | keep | The proposed provider-limrun destination has no seam. Its constructor builds the root dependency factory `src/sdk/limrun-runtime-dependencies.ts`, which is the ADR 0019 composition seam. This loads the root adb-host binder, core Android interactor, and platform-runtime app-state helpers, all prohibited package imports. Moving the class also moves that composition. That is a design change, not a move. |
| `src/request-progress-protocol.ts` | moved → `packages/daemon-contracts/src/request-progress-protocol.ts` | This follows #2559's shared-contract decision. The client reads it statically through `daemon-client-progress.ts`; the server reads it through `packages/daemon/src/server/`. Only shared placement and wire-compat ledgers constrain it. #3288 declared `daemon-contracts`; extraction made it physical and moved wire-ledger keys with it. Contracts was rejected because R18 excludes envelope validation mechanics. |
| `src/runtime-command-surface.ts` | moved → `src/command-runtime/runtime-command-surface.ts` ([#3299](https://github.com/callstack/agent-device/pull/3299)) | The command-surface binding resides beside `runtime-factory.ts` as one assembly group. Their folder derives `command-runtime` ownership. `topFolder` replaces per-file `ROOT_MODULE_ZONES` declarations. |
| `src/runtime-factory.ts` | moved → `src/command-runtime/runtime-factory.ts` ([#3299](https://github.com/callstack/agent-device/pull/3299)) | The runtime assembly folder derives `command-runtime` ownership without per-file `ROOT_MODULE_ZONES` declarations. |

### sdk

| File | Decision | Reason |
| --- | --- | --- |
| `src/sdk/limrun.ts` | keep | This file is the published `agent-device/limrun` facade. `tsdown.config.ts` builds it as the bundle entry, and `package.json#exports` ships `dist/src/limrun.js`. A published facade cannot reside in a private workspace package. |
| `src/sdk/limrun-runtime-types.ts` | keep | This public session-type refinement is the provider session with the platform `AndroidAdbProvider` types swapped in. It exists because the published surface differs from the package-internal surface, whose identical names it `Omit`s. A provider-limrun home requires renamed or dual-exported internal types. That is a design change, not a move. |

## Batch 1 (this decision's companion PR)

Git history retains the completed batch.

## Follow-ups (tracked on #3281)

Physical root-pass moves continue under [#3294](https://github.com/callstack/agent-device/issues/3294) (child of #3276).
Git history retains completed move records.
The decision table retains ownership rationale.

## The daemon package's export surface

`@agent-device/daemon` has one entry, `.`, at `packages/daemon/src/index.ts`.
It explicitly re-exports, by name, what the daemon process root uses.
These are `startDaemonRuntime` and the types that the root's composition and platform-runtime modules name.
It has no `export *`.
This package boundary is the only permitted barrel.
Layer folders contain no barrels.

A package value import evaluates the daemon server graph.
Root code that needs only command metadata therefore reads its owner directly.
The route owner-file claims reside beside the per-command claims in `@agent-device/command-registry/owner-files`.
Wire request and response types come from `@agent-device/contracts/command` and `@agent-device/kernel/contracts`.

The transitional `./testing/` entries are gone.
The last of them went behind the consumers that moved off them in
[#3728](https://github.com/callstack/agent-device/pull/3728),
[#3733](https://github.com/callstack/agent-device/pull/3733), and
[#3742](https://github.com/callstack/agent-device/pull/3742).
`scripts/layering/package-entry-surface.ts` owns the surface under R83.
This document states the decision, not the check.
Package tests import their subject relatively.
Composed root tests reach the daemon through `startDaemonRuntime` from the entry.

## Refuted alternatives

- **Move every ≥80% community match into its dominant zone: rejected.**
  The measure describes consumers.
  Host-kit, contracts, selectors, and device-selection are shared foundations and score poorly by construction.
  Reversed dependencies invert the spine.
- **`durable-json.ts` → contracts: rejected.**
  Pure-JSON helpers appear similar to `contracts/json.ts`.
  However, they validate durable-descriptor persistence, while R18 restricts contracts to wire vocabulary.
- **Ledgers → managed-allocation, with capture-kit importing them back: rejected as proposed.**
  Managed-allocation's record codec requires capture-kit durable mechanics.
  The reverse edge completes a cycle prohibited by R4/R11.
  Removal of the required import first would permit reconsideration.
  This entry rejects the sequence, not the destination.

## The enduring rule

Judge collocation by ownership: the location that minimizes independently maintained declarations per change.
Community scores identify candidates only.
A guard's current path lists, for example R13, R76, and R78, are constraints that a relocation must account for.
They are never independent evidence that a location must stay.
If only a path supports retention, mark the row "retain for this batch".
The next pass then re-opens it instead of treating it as settled.
