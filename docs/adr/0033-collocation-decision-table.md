# 0033. Collocation decision table

Status: accepted.
This decision evaluates the 48 candidate files in umbrella #3276 §5.
At `ff685ad80`, declared zones score 0.373 Louvain modularity, compared with 0.564 for detected communities.
Each candidate has a `move`, `merge`, or `keep` decision with rationale.
Moves use `refactor(move)` PRs.
Git history retains completed move batches.

The allocator design withdrawal removed `packages/managed-allocation` on 2026-10-10; see [ADR 0021](0021-host-simlock-managed-device-allocation.md).
The `src/managed-device-allocation.ts` row records the rationale for #3287's move, later deleted with that package.
Nothing moves there now.
Rows that reject this destination or cite its capture-kit dependency as a cycle no longer bind.
Re-evaluate those files against their remaining edges.

## Rules at a glance

- A `keep` row records a decision.
  Its rationale identifies the examined direction and why it fails, usually a package cycle or spine inversion.
- A detected community does not independently justify a move.
  Shared foundations often belong to their consumer's detected community.
  The table records valid ownership locations, often the existing locations.
- A move requires an actual target boundary.
  It introduces no new dependency direction, moves no root composition into a package, and preserves the file's imports.
  If a proposal is infeasible, record that result without an issue to propose it again.
- Path-keyed R13 importer lists, R76 inventory, and R78 scope describe existing boundaries.
  They do not prove optimal placement.
  If a row has only path evidence, mark it "retain for this batch — relocation requires coordinated ownership changes".
  A package cycle rejects that proposed direction.
  It does not prohibit a future design that first removes the cycle-closing edge.

## Decision table

### capture-kit

| File | Decision | Reason |
| --- | --- | --- |
| `src/capture-admission/audio-probe-admission-ledger.ts` | keep (proposed move rejected) | The proposed move to managed-allocation adds capture-kit→managed-allocation. The reverse dependency already exists, so this forms an R4 package cycle. This rejects the direction, not a future design that first removes the cycle-closing edge. Moving the record codec off capture-kit is one example. |
| `src/capture-admission/durable-capture-admission-ledger.ts` | keep (proposed move rejected) | The same direction is rejected. This generic engine serves three per-resource ledgers. Capture-kit's `durable-capture-resource.ts` and `durable-capture-start-preflight.ts` consume it. |
| `src/capture-admission/perf-capture-admission-ledger.ts` | keep (proposed move rejected) | The same direction is rejected. This four-line specialization belongs beside its package-owned ledger. |
| `src/capture-admission/screen-recording-admission-ledger.ts` | keep (proposed move rejected) | The same direction is rejected. Capture-kit's screen-recording session resource and stop-recovery consume it. |
| `src/durable-json.ts` | keep (proposed move rejected) | Managed-allocation already imports this capture-kit module. Reversal forms a package cycle unless that import disappears first. Contracts beside `json.ts` was also rejected: R18 owns wire vocabulary, not durable-descriptor validation mechanics. Three managed-allocation `record-*` consumers explain the community coupling and can remain. |
| `src/snapshot/snapshot-evidence.ts` | keep | This is snapshot-capture mechanics. The daemon-dominated community represents consumers. A daemon-server home would force every platform and provider to depend on the daemon zone for capture evidence. |
| `src/snapshot/snapshot-freshness/index.ts` | keep | This is platform-neutral freshness policy. Capture-kit, platforms, and daemon currently import it downward. |
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
| `src/facades/device.ts` | keep | This published contracts facade defines the package boundary. It is not movable implementation content. |
| `src/interaction-guarantees.ts` | keep | AGENTS.md names this declaration site for interaction dispatch paths and guarantee cells under ADR 0011. Cross-language golden tables in `contracts/fixtures/` associate it with this package. |
| `src/managed-device-allocation.ts` | move (batch 1) → `packages/managed-allocation` | Only managed-allocation and its dependent daemon composition consume this port and vocabulary; see [ADR 0021](0021-host-simlock-managed-device-allocation.md) §3. No other contracts file or zone imports it. Types therefore belong beside their implementing operations. |
| `src/wait-runtime-plan.ts` | keep | Command-registry and daemon-server share it. Both are spine zones; contracts is the only boundary below them. |

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
| `src/diagnostics.ts` | keep | AGENTS.md mandates this diagnostics boundary for all zones. Its repository-highest consumer count reflects a shared substrate, not incorrect placement. |
| `src/internal/request-cancel.ts` | keep | AGENTS.md routes request cancellation through `host-kit/request`. Its internal mechanics already reside beside the facade. |
| `src/request.ts` | keep | AGENTS.md names host-kit as the boundary for these cross-layer request contracts. Consumers span every zone. |
| `src/session-paths.ts` | keep | Daemon, cli, and platforms resolve this session-artifact path grammar. AGENTS.md assigns path policy to `packages/daemon-contracts/src/session-artifact-paths.ts`, which consumes it. |

### kernel

| File | Decision | Reason |
| --- | --- | --- |
| `src/device-isolation.ts` | keep | Only kernel places this device-isolation vocabulary below device-selection, replay-port, and daemon. |

### platform-android

| File | Decision | Reason |
| --- | --- | --- |
| `src/device-boot.ts` | keep | ADR 0019/R13 assign boot mechanics to the platform. Root consumers perform composition through their own platform package loads. |

### platform-apple

| File | Decision | Reason |
| --- | --- | --- |
| `src/runner-owner-facade.ts` | keep | ADR 0005 defines the runner-owner boundary. R13 owns platform composition exports. The root importer is the designated host. |
| `src/runner/legacy-xctest-device-set.ts` | keep | Runner-internal legacy device-set parsers reside beside their runner. |
| `src/simulator-boot.ts` | keep | ADR 0009 assigns simulator boot mechanics to the platform. The package's kernel device model and xctestrun preparation must remain synchronized with them. |

### replay-port

| File | Decision | Reason |
| --- | --- | --- |
| `src/daemon-port/session-test-shard-devices.ts` | keep | This daemon-port adapter already colocates its shard enumeration binding. The `replay-test` scheduler deliberately never enumerates hardware. A move toward that zone breaks the port. |

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
The complete `daemon-contracts` zone resides in `packages/daemon-contracts`.
Folders and packages derive these zones, so moved files no longer need `ROOT_MODULE_ZONES` rows.

The remaining shared daemon/client file, `provider-credential-fingerprint.ts`, follows #2559's decision.
That decision moved shared contracts **to the process root** to remove client imports of `packages/daemon/src/`.
The `client-side` logical-module policy prohibits those imports from these consumers:

- CLI.
- Typed client.
- Remote transports.
- `src/daemon-client/`.

R78 also prohibits access through any root module reachable by the CLI process.
#3288's `daemon-contracts` zone declared ownership below both daemon and client.
Package extraction makes it physical.
R11 and package dependencies preserve that boundary.
Rows supported only by path-keyed evidence say "retain for this batch".
Current path lists constrain moves without independently proving optimal placement.

| File | Decision | Reason |
| --- | --- | --- |
| `src/daemon-diagnostics-scope.ts` | moved → `packages/daemon-contracts/src/daemon-diagnostics-scope.ts` ([#3297](https://github.com/callstack/agent-device/pull/3297) into `src/daemon-contracts/`, then the package extraction) | The complete zone resides in `packages/daemon-contracts`. Its directory derives zone ownership without per-file `ROOT_MODULE_ZONES` rows. An internal rename therefore needs no ownership-table edit. |
| `packages/daemon-contracts/src/device-claim-recovery.ts` | keep (shared-below-both) | The owner-scoped reconciler recovers durable resources from a dead owner's state directory. Daemon `open`/startup and daemonless `device release --stale` both run it. It therefore belongs below both. Runtime recovery may reside in `daemon-contracts` only with both consumers and gateway-only root composition, per ADR 0019 section 1. The package depends on `capture-kit`. A reverse dependency forms a project-reference cycle through `selectors`. |
| `src/daemon-policy-file.ts` | moved → `packages/daemon-contracts/src/daemon-policy-file.ts` | This shared daemon/client contract follows #2559 and #3288's `daemon-contracts` declaration. Rank-5 daemon-client dynamically imports it, so the spine requires a home below both. Package extraction supplies that physical home with manifest-owned exports. |
| `src/daemon.ts` | keep | This is the `internal/daemon` bundle entry. Umbrella §4 keeps composition roots at the root. |
| `src/platform-runtime-apple-runner-owner.ts` | retain for this batch | R13's exact-importer rule and ADR 0022's R76 inventory use this `platform-runtime-*` composition path. Relocation requires coordinated changes to both declarations. The rules constrain the move without independently proving placement. |
| `src/platform-runtime-daemon-lifecycle.ts` | retain for this batch | The same path-keyed R13/ADR 0022 boundary requires coordinated declaration changes for relocation. |
| `src/platform-runtime-device-boot.ts` | retain for this batch | The same path-keyed R13/ADR 0022 boundary applies. |
| `src/platform-runtime-resource-cleanup.ts` | retain for this batch | The same path-keyed R13/ADR 0022 boundary applies. |
| `src/provider-credential-fingerprint.ts` | keep (type extracted) | Like `daemon-policy-file.ts`, this shared daemon/client contract follows #2559. #3288 places it beside provider composition that consumes fingerprinted credentials. Daemon extraction PR 6 moved only `DaemonProviderCredentials` to `packages/daemon-contracts` at `./provider-credentials`, below both consumers. The implementation remains here because it reads the installed-plugin manifest. |
| `src/provider-limrun-runtime.ts` | keep | The proposed provider-limrun destination lacks a valid boundary. Its constructor builds root `src/sdk/limrun-runtime-dependencies.ts`, the ADR 0019 composition factory. This loads the root adb-host binder, core Android interactor, and platform-runtime app-state helpers, all prohibited package imports. Moving the class also moves composition and therefore requires design changes. |
| `src/request-progress-protocol.ts` | moved → `packages/daemon-contracts/src/request-progress-protocol.ts` | This follows #2559's shared-contract decision. The client reads it statically through `daemon-client-progress.ts`; the server reads it through `packages/daemon/src/server/`. Only shared placement and wire-compat ledgers constrain it. #3288 declared `daemon-contracts`; extraction made it physical and moved wire-ledger keys with it. Contracts was rejected because R18 excludes envelope validation mechanics. |
| `src/runtime-command-surface.ts` | moved → `src/command-runtime/runtime-command-surface.ts` ([#3299](https://github.com/callstack/agent-device/pull/3299)) | The command-surface binding resides beside `runtime-factory.ts` as one assembly group. Their folder derives `command-runtime` ownership. `topFolder` replaces per-file `ROOT_MODULE_ZONES` declarations. |
| `src/runtime-factory.ts` | moved → `src/command-runtime/runtime-factory.ts` ([#3299](https://github.com/callstack/agent-device/pull/3299)) | The runtime assembly folder derives `command-runtime` ownership without per-file `ROOT_MODULE_ZONES` declarations. |

### sdk

| File | Decision | Reason |
| --- | --- | --- |
| `src/sdk/limrun.ts` | keep | This publishes `agent-device/limrun`. `tsdown.config.ts` builds the bundle entry, and `package.json#exports` ships `dist/src/limrun.js`. A published facade cannot reside in a private workspace package. |
| `src/sdk/limrun-runtime-types.ts` | keep | This public session-type refinement replaces provider session types with platform `AndroidAdbProvider` types. The published surface differs from the internal surface, whose identical names it `Omit`s. A provider-limrun home requires renamed or dual-exported internal types. That requires design changes, not only a move. |

## Batch 1 (this decision's companion PR)

Git history retains the completed batch.

## Follow-ups (tracked on #3281)

Git history retains completed move records.
The decision table retains ownership rationale.

## The daemon package's export surface

`@agent-device/daemon` has one entry, `.`, at `packages/daemon/src/index.ts`.
It explicitly re-exports named values/types used by process-root composition and platform-runtime modules.
These include `startDaemonRuntime` and required types.
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
  The decision rejects the sequence, not the destination.

## The enduring rule

Judge collocation by ownership: the location that minimizes independently maintained declarations per change.
Community scores identify candidates only.
Current R13, R76, and R78 path lists constrain relocation but never independently prove required placement.
If only a path supports retention, mark the row "retain for this batch".
A later pass then re-examines it instead of treating it as settled.
