# iOS Simulator AX bridge spike

- Decision: **INCONCLUSIVE — public AX NO-GO; guest AX bridge requires the full corpus**
- Status: **reopened after candidate-coverage correction**
- Revision: 5ad244596c73f0884a48eb6445da3262d7eecb87 (takeover/2209-valid-evidence)
- Target: AgentDevice-2209-Takeover (F578F08D-BEA1-4A56-8A4B-C92B040FBA94, com.apple.CoreSimulator.SimRuntime.iOS-26-2)
- Generated: 2026-09-01T14:27:51.339Z
- Corpus: states=warm, screens=quiet, list, samples=20
- Corpus coverage: **decisive-early-stop**

The generated run originally reported an overall NO-GO. That verdict was too broad: the
`private-coresimulator-ax` adapter returned `private-tool-unavailable` solely because no
`--private-tool` path was supplied. It did not discover, build, or execute a private candidate.
The gzipped JSON remains the immutable original run; the correction and independent live probe
below are intentionally recorded separately.

## Environment and limits

- Node: v26.1.0
- pnpm: 11.21.0
- Xcode: Xcode 26.2; Build version 17C52
- simctl: @(#)PROGRAM:simctl  PROJECT:CoreSimulator-1155.4
- Swift: Apple Swift version 6.2.3 (swiftlang-6.2.3.3.21 clang-1700.6.3.2)
Target: arm64-apple-macosx26.0
- OS: darwin 25.5.0; arch=arm64
- Bounds: request=65536 B, response=4194304 B, nodes=1500, traversal=12, CPU=2000 ms, memory=268435456 B, duration=5000 ms

## Candidate fidelity and limitation matrix

| Candidate | Mechanism | App surface | System surface | Lifecycle | Main limitation |
|---|---|---|---|---|---|
| public-macos-ax | public macOS ApplicationServices AX | observed in successful cells | not exercised | framed protocol | list evidence is flatter and has different identifier coverage (depth 1 vs 4; identifiers 42 vs 11) |
| private-coresimulator-ax | external/private CoreSimulator AX tool | not exercised in the generated corpus | not exercised | framed protocol contract only | the run supplied no tool, so it cannot support a viability verdict |
| xctest-control | #2189 XCTest runner control | observed in successful cells | not exercised | existing runner lifecycle | control, not a host-side AX bridge |

## Raw acquisition and prototype presentation results

| Candidate | State | Screen | Readable/attempted | Wall p50/p95 ms | Gated duration p50/p95 ms | First look p95 ms | Presentation p50/p95 ms | Nodes | Failures |
|---|---|---|---:|---:|---:|---:|---:|---:|---:|
| public-macos-ax | warm | quiet | 20/20 | 135.4/276.3 | 121.6/231.9 | 135.4/276.3 | 0.0/0.2 | 4.0 | 0 |
| public-macos-ax | warm | list | 20/20 | 1330.6/2554.9 | 1314.5/2527.0 | 1330.6/2554.9 | 1.6/2.5 | 114.0 | 0 |
| xctest-control | warm | quiet | 20/20 | 249.7/706.0 | 249.5/705.7 | 249.7/706.0 | 0.1/0.2 | 4.0 | 0 |
| xctest-control | warm | list | 20/20 | 471.8/579.0 | 471.4/578.8 | 471.8/579.0 | 0.2/0.5 | 33.0 | 0 |

Raw exemplar fidelity (public AX vs XCTest control):
- quiet: nodes 4/4; depth 1/2; identifiers 0/1.
- list: nodes 114/33; depth 1/4; identifiers 42/11.

Every acquisition sample retains timing, resource, readiness, and failure evidence; the first successful sample in each cell also retains one raw node-tree exemplar with viewport, target generation, truncation, and residue. Presentation samples measure only construction of the #2190 acquired carrier; they do not apply visibility, hittability, scope, depth, or semantic compaction.

## Direct protocol probes

- public-macos-ax/protocol-probe:public-macos-ax: ok=true, failure=none, code=none, nodes=1, duration=2234.7 ms, CPU=5.1 ms, memory=11468800 B, response=707 B
- private-coresimulator-ax/protocol-probe:private-coresimulator-ax: ok=false, failure=unsupported-mechanism, code=private-tool-unavailable, nodes=0, duration=0.0 ms, CPU=– ms, memory=– B, response=0 B
- stderr public-macos-ax/protocol-probe:public-macos-ax: [ios-ax-spike] capture id=protocol-probe:public-macos-ax candidate=public-macos-ax screen=unprepared-surface
- stderr private-coresimulator-ax/protocol-probe:private-coresimulator-ax: empty

`private-tool-unavailable` is setup evidence, not mechanism evidence. In the adapter at this
revision, omitting `--private-tool` or naming a path that does not exist constructs this response
without starting a process.

## Post-run candidate audit

An independent audit on 2026-09-01 used the official idb v1.5.2 arm64 release
(`idb-companion.macos-arm64.tar.gz`, SHA-256
`f17b718a513931705542a7fbfa9cfc11895ee191562c9ffd2343cf7f8254bc08`), including its bundled
`Resources/SimulatorFrameworkBridge`, on macOS 27.0 (26A5421a), Xcode 27.0 (27A5252f), and a booted
iOS 27.0 iPhone 17 Pro Simulator. Settings was foregrounded; the read used
`ui describe-all --api axbridge-persistent --format complete --profile` with label, identifier,
frame, and type. No `.xctest` bundle, test runner, or agent-device runner was started.

- Backend reported: `axbridge-exclusive` (the persistent guest bridge's held session).
- First successful read: 167 elements, not truncated, one Mach round trip, 49,313 response bytes,
  956.0 ms total including bridge startup, and 56.9 ms guest read time.
- Six subsequent reads returned the same 167-element, non-truncated tree with one Mach round trip.
  Total profile time ranged from 39.9 to 53.7 ms (p50 43.6 ms); guest read time ranged from 30.9 to
  39.4 ms.
- A prior attempt against a black/unready Simulator failed with an explicit frontmost-application
  resolution error. Foregrounding Settings on a healthy Simulator separated target readiness from
  bridge availability.
- The companion was stopped after the audit and removed its temporary directory.

This audit proves that a compatible, no-XCTest guest AX mechanism exists, runs on the current host,
returns a detailed batched tree, and has enough warm latency headroom to justify the full #2192
corpus. It does not prove the remaining system-surface, lifecycle, cancellation, stale-generation,
relaunch, or multi-screen acceptance cells, so it is not a production GO by itself.

## Independent positive-control evidence

- Invalid shallow rule: exit=1; command=pnpm bench:ios-snapshot:deep-button -- --rule invalid-shallow; assertion=AssertionError: changed descendant was omitted by shallow observation; no-effect claim is invalid.
- Safe full rule: exit=0; command=pnpm bench:ios-snapshot:deep-button -- --rule safe-full; assertion=full observation changed and includes the changed descendant.

## Preference experiment

- Applied: **true**
- Restored: **true**
- Fixture launch compatible: **true**
- Simulator state before experiment: Shutdown
- Private/preboot preference keys are experimental only; they were applied to this shutdown disposable Simulator and the original plist bytes were restored.
- /Users/thymikee/Library/Developer/CoreSimulator/Devices/F578F08D-BEA1-4A56-8A4B-C92B040FBA94/data/Library/Preferences/com.apple.Accessibility.plist: existed=true, beforeSha256=0c85a9ace2ad2c1be37a09a2ceea94fb786d4e163b4c181307bc991038a3b514, afterSha256=23695eb18c42e49869332f9149ad7005efd9d8e143c951e1396b8e67f2b4c179
  - Changes: AccessibilityEnabled: false -> true; ApplicationAccessibilityEnabled: 0 -> true; AutomationEnabled: 0 -> true; IgnoreAXServerEntitlements: undefined -> true
- /Users/thymikee/Library/Developer/CoreSimulator/Devices/F578F08D-BEA1-4A56-8A4B-C92B040FBA94/data/Library/Preferences/com.apple.UIAutomation.plist: existed=true, beforeSha256=db8995177327a963486dd0607260f0fad74ad10d9dec6c2f5abdbaf0dbd00b2c, afterSha256=db8995177327a963486dd0607260f0fad74ad10d9dec6c2f5abdbaf0dbd00b2c
  - Changes: none

## Lifecycle, cancellation, and recovery

- Source: framed-protocol-fixture
- Process crash: process-crash; recovered=true
- Timeout: timeout; recovered=true
- Cancellation: cancelled; recovered=true
- Stale generation: stale-generation; recovered=true

## Decision rationale

- public-macos-ax warm/quiet acquisition missed the 75/150 ms target.
- public-macos-ax warm/list acquisition missed the 75/150 ms target.
- The generated private candidate result only proved that no tool path was supplied.
- The post-run idb audit disproved the claim that a compatible private mechanism was unavailable
  and passed the warm latency threshold on one detailed Settings screen.
- The overall verdict is therefore inconclusive. Public AX remains NO-GO; the idb-style persistent
  guest bridge is GO for full-corpus evaluation, not yet GO for production.

## Next interface boundary

- Adapt the idb-style persistent guest reader behind the #2190 acquisition boundary and run every
  remaining #2192 state and screen cell while preserving raw facts.

## Production boundary

- No production backend selection, fallback, runner-demand, open/relaunch, proxy, XCTest interaction, or public CLI changes were made.
- Production routing remains blocked until the guest bridge passes the full correctness, lifecycle,
  and latency corpus. The original zero-cell private result must not be used to close #2192.
