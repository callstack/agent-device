# ADR 0038: Snapshot capture source routing

## Status

Proposed for [#4205](https://github.com/callstack/agent-device/issues/4205).
No production migration precedes acceptance.
On acceptance, this replaces ADR 0004's source-routing rules and ownership.
ADR 0004 retains iOS acquisition, presentation, geometry, and system-surface contracts.
Completed migration history stays in git history.

## Rules at a glance

- Route owners with more than one channel through the capture-kit router.
- Permit one fallback; share refusal scope, circuits, and warnings.
- Every producer stamps served identity through capture-kit and declares a contracts registry row.

## Boundary and channels

`@agent-device/capture-kit` owns the router: planning, proof, fallback, circuits, identity, warnings.
Allow neutral contracts, kernel primitives, host-kit capabilities, and capture-kit policy imports.
Forbid direct, transitive, and dynamic dependencies on platform/provider code.
Bound runtime owners retain channels across requests and close only owned resources.
Keep lease/lock authority ([ADR 0007](0007-remote-device-leases.md)).

Contracts defines `SourceChannel<T>`:

| Member | Contract |
| --- | --- |
| `id`, `producer` | Separate transport from producer; both bridge transports emit `simulator-ax-bridge`. |
| `acquire({ target, hint, proof, signal })` | Return acquired/presented evidence, served identity, residue, proof; or typed refusal. |
| `resolveTarget(device, app, signal)` | Return real target `T`, device key, target id, optional verified generation; or typed discovery-pending. |
| `refreshTarget?(device, app, signal)` | Verify cached identity; omit when resolution already verifies identity. |
| `awaitDiscovery?(device, signal)` | Await detached discovery; omit when none exists. |
| `proof` | `'none'` or `SurfaceProof`. |
| `supports` | Declare `customActions`, `observeOnly`, and supported `pinnedBackend` values. |

Operations share remaining budget and cancellation.
Hints separate raw and presented depth; presentation owns scope.
Discovery-pending requires `awaitDiscovery` or an available alternate.
No constant callbacks, `targetFreshness`, or fabricated pids/generations are allowed.

`SurfaceProof(device, signal)` returns `'clear'`, `{ occluded: surfaceId }`, or `'unproven'`.
`'none'` requires no separate absence proof and asserts none.
Occlusion selects a surface-capable channel; unproven acquisition must refuse occluded/unverified reads through integrated checks.
Never cache absence across captures.

Both bridges probe registered hosts through runner foreground state.
Only provider probes may prepare their required runner.
If unproven, pass host executables into the bridge's pre/post-read process checks.
Forbid host-side process probes.
Serve registered hosts in place without activation or rebinding, per ADR 0004.

## Planning, fallback, and refusals

Pure `plan(input)` takes ordered owner channels, options, target/proof evidence, circuits, and a current-loop backend pin.
It returns selected channel, typed reason, and at most one eligible alternate.
It owns eligibility, observe-only, and pins; unsupported requests fail before acquisition.
Never relax pins or activate for observe-only.
Stable capture supplies its current-loop private-AX backend pin; previous snapshots cannot pin its first read.

One settlement path handles resolution, acquisition, presentation, and alternates.
Attempt one alternate at most; its failure retains the first reason.
Cancellation neither falls back nor changes circuits.
Channels/presenters cannot route recursively.
XCTest tiers and Android helper recovery stay internal and cannot select another channel.

Key circuits by owner, device key, channel id, target id, and verified generation.
Generation refusals disable that channel; new generations clear old circuits.
Refresh cached targets before honoring disabled circuits and after stale-target evidence.
If refresh fails, retain only circuit bookkeeping; publish no cached generation.
Without verified generation, create no generation circuit.

Generalize `contracts/fixtures/ios-snapshot-bridge-refusals.json` into router input for all typed-refusal channels.
Entries key on producer/code and declare scope plus warning consequence; bridge transports share entries.
Preserve iOS scope:

| Scope | Evidence |
| --- | --- |
| Capture | Preparation, read-in-flight, tree change, foreground ownership, unresolved coordinates, window placement, surface-host presence or uncertainty. |
| Generation | Remote-content boundary, abandoned read, malformed tree, presentation invariant failure. |
| Runner session | Wedged runner-side bridge reader; a new runner session id starts a fresh circuit. |

Unknown codes have generation scope.
Without a verified generation, an unknown code disables the channel for the current capture and creates no circuit.
Intercept cancellation before lookup, including `abort-signal`.
Unclassified provider errors remain terminal.

## Producers and publication

Define platform-neutral `SnapshotProducer` and one contracts registry with `satisfies Record<SnapshotProducer, ProducerFacts>`.
Rows declare backend channels, truncation, residue policy, quiet time, and ref-namespace owner.
Residue distinguishes source-measured and provider-derived facts.
Derive provenance pairs, iOS subsets, producer warning dispatch, quiet time, and ref behavior here.
First move provenance-dependent carriers/helpers from `packages/kernel/src/snapshot.ts` to contracts.
Keep node/geometry primitives in kernel; forbid kernel-to-contracts cycles.
Keep bridge quiet time at 300 ms, others at 500 ms; derive it per capture from the served producer.
Preserve agent-browser refs.

Local and Limrun iOS Simulators offer bridge first, then `apple-runner`, and route through the router.
Every other owner has one channel and does not route through the router: Android, macOS helper/XCTest, web, WebDriver, Revyl, HarmonyOS, Linux, TV CDP, composing providers, and physical iOS, tvOS, and visionOS.
A one-channel owner calls the capture-kit identity-stamp helper and declares its registry row.
An owner that gains a second channel moves to the router.
Unsupported owners such as Vega declare no channel.
WebDriver keeps `appium-source` on both backend channels.
Rename Revyl Android to `revyl-android-tree`; sharing a parser does not make it Appium.

Stamp identity once after presentation: actual producer, intent, served target/generation, presentation key, residue.
Served surfaces override planned app lineage and discard app-generation residue.
Failed generation resolution carries per-capture unknown-generation residue.
Channels without generation support declare it unavailable; surfaces carry no app generation.
Preserve iOS producer names and fallback wording.
One-channel success adds no fallback warning; assembly retains quality/freshness disclosures.

Android `systemSurfaceOnly` stays acquisition metadata, not `SurfaceProof`.
`packages/platform-android/src/snapshot-content-recovery.ts` accepts usable system-only trees.
This and system-bar labels prove no absence: use `proof: 'none'`, preserving disclosure/recovery.
A future app-only channel needs independent window-ownership evidence tied to its read.

## Consequences

The migration plan, its guard inventory, and the live parity checks live in [#4205](https://github.com/callstack/agent-device/issues/4205).
Repo guards enforce the router's layering, the producer emitters, and the refusal table scope.

## Rationale and alternatives

Readers, decoding, discovery, process checks, native budgets, geometry, and lifecycle stay platform-specific.
Presentation stays in capture-kit and runner-side Swift.

Rejected: Apple placeholder ports (absent capabilities), provider planners (duplicated policy), annotations as absence proof (no pre-read evidence), and routing one-channel owners through the router (the planner never chooses for them).
The cost is provenance migration and explicit channels.
