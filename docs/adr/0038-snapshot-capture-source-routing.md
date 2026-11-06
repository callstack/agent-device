# ADR 0038: Snapshot capture source routing

## Status

Proposed for [#4205](https://github.com/callstack/agent-device/issues/4205).
No production migration precedes acceptance.
On acceptance, this replaces ADR 0004's source-routing rules and ownership.
ADR 0004 retains iOS acquisition, presentation, geometry, and system-surface contracts.
Completed migration history stays in git history.

## Rules at a glance

- Route every supported capture through capture-kit channels.
- Permit one fallback; share refusal scope, circuits, and warnings.
- Stamp served identity; derive producer facts from contracts.

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

Unknown codes have generation scope if verified.
Intercept cancellation before lookup, including `abort-signal`.
Unclassified provider errors remain terminal.

## Producers and publication

Define platform-neutral `SnapshotProducer` and one contracts registry with `satisfies Record<SnapshotProducer, ProducerFacts>`.
Rows declare backend channels, truncation, residue policy, quiet time, and ref-namespace owner.
Residue distinguishes source-measured and provider-derived facts.
Derive provenance pairs, iOS subsets, producer warning dispatch, quiet time, and ref behavior here.
First move provenance-dependent carriers/helpers from `packages/kernel/src/snapshot.ts` to contracts.
Keep node/geometry primitives in kernel; forbid kernel-to-contracts cycles.
Keep bridge quiet time at 300 ms, others at 500 ms; preserve agent-browser refs.

One-channel owners have no alternate: Android, macOS helper/XCTest, web, WebDriver, Revyl, HarmonyOS, Linux, TV CDP, and composing providers.
Local and Limrun iOS Simulators offer bridge first, then `apple-runner`.
Physical iOS, tvOS, and visionOS retain one runner channel.
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

## Migration and enforcement

After acceptance, each small PR must merge alone:

1. Move provenance carriers to contracts; migrate registry consumers atomically.
2. Add router/refusal input and layering enforcement; port guest/runner tests with unchanged behavior assertions.
3. Bind both iOS channels; remove old routing, placeholder ports, duplicate eligibility, and fallback settlers.
4. Bind single-source owners separately; rename Revyl Android with its emitter/consumers.
5. Slim ADR 0004 below about 15 KB after relocating unique contracts; retain iOS rules.

Add router layering enforcement with a failing dependency control.
Producer-emitter/refusal guards in `test/repo-guards/` reject missing reachable production emitters, unlisted codes, and scope disagreement.
Add an ADR-citation guard for nonexistent cited paths/test names.
Select guards through affected checks with docs-prose, docs-links, and agent-guidance.
Require live producer/fallback parity on local iOS Simulator, Limrun iOS, and local Android.

## Rationale and alternatives

Readers, decoding, discovery, process checks, native budgets, geometry, and lifecycle stay platform-specific.
Presentation stays in capture-kit and runner-side Swift.

Rejected: Apple placeholder ports (absent capabilities), provider planners (duplicated policy), and annotations as absence proof (no pre-read evidence).
The cost is provenance migration and explicit channels.
