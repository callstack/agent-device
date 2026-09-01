# iOS Simulator AX bridge spike

- Decision: **NO-GO**
- Status: **completed**
- Revision: acfa7550af709ac75228968e00946fa0089888fd (takeover/2209-valid-evidence)
- Target: AgentDevice-2209-Takeover (F578F08D-BEA1-4A56-8A4B-C92B040FBA94, com.apple.CoreSimulator.SimRuntime.iOS-26-2)
- Generated: 2026-09-01T13:11:40.532Z
- Corpus: states=warm, screens=quiet, list, samples=20
- Corpus coverage: **decisive-early-stop**

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
| public-macos-ax | public macOS ApplicationServices AX | observed in successful cells | not exercised | framed protocol | list evidence is substantially flatter and has different identifier coverage (depth 1 vs 2; identifiers 42 vs 12) |
| private-coresimulator-ax | external/private CoreSimulator AX tool | unsupported before corpus | unsupported before corpus | framed protocol contract only | private interface/tool compatibility |
| xctest-control | #2189 XCTest runner control | observed in successful cells | not exercised | existing runner lifecycle | control, not a host-side AX bridge |

## Raw acquisition and prototype presentation results

| Candidate | State | Screen | N | Acquisition p50/p95 ms | First look p95 ms | Presentation p50/p95 ms | Nodes | Failures |
|---|---|---|---:|---:|---:|---:|---:|---:|
| public-macos-ax | warm | quiet | 20 | 52.3/77.3 | 52.3/77.3 | 0.0/0.1 | 4.0 | 0 |
| public-macos-ax | warm | list | 20 | 1101.5/2136.4 | 1101.5/2136.4 | 1.1/1.6 | 114.0 | 0 |
| xctest-control | warm | quiet | 20 | 286.7/358.3 | 286.7/358.3 | 0.0/0.2 | 4.0 | 0 |
| xctest-control | warm | list | 20 | 618.7/808.5 | 618.7/808.5 | 0.2/0.9 | 31.0 | 0 |

Raw exemplar fidelity (public AX vs XCTest control):
- quiet: nodes 4/4; depth 1/2; identifiers 0/1.
- list: nodes 114/31; depth 1/2; identifiers 42/12.

Every acquisition sample retains timing, resource, readiness, and failure evidence; the first successful sample in each cell also retains one raw node-tree exemplar with viewport, target generation, truncation, and residue. Presentation samples measure only construction of the #2190 acquired carrier; they do not apply visibility, hittability, scope, depth, or semantic compaction.

## Direct protocol probes

- public-macos-ax/protocol-probe:public-macos-ax: ok=true, failure=none, code=none, nodes=1, duration=2367.5 ms, CPU=5.6 ms, memory=11485184 B, response=693 B
- private-coresimulator-ax/protocol-probe:private-coresimulator-ax: ok=false, failure=unsupported-mechanism, code=private-tool-unavailable, nodes=0, duration=0.0 ms, CPU=– ms, memory=– B, response=0 B
- stderr public-macos-ax/protocol-probe:public-macos-ax: [ios-ax-spike] capture id=protocol-probe:public-macos-ax candidate=public-macos-ax screen=unprepared-surface
- stderr private-coresimulator-ax/protocol-probe:private-coresimulator-ax: empty

## Independent positive-control evidence

- Invalid shallow rule: exit=1; command=pnpm bench:ios-snapshot:deep-button -- --rule invalid-shallow; assertion=AssertionError: changed descendant was omitted by shallow observation; no-effect claim is invalid.
- Safe full rule: exit=0; command=pnpm bench:ios-snapshot:deep-button -- --rule safe-full; assertion=full observation changed and includes the changed descendant.

## Preference experiment

- Applied: **true**
- Restored: **true**
- Fixture launch compatible: **true**
- Simulator state before experiment: Shutdown
- Private/preboot preference keys are experimental only; they were applied to this shutdown disposable Simulator and the original plist bytes were restored.
- /Users/thymikee/Library/Developer/CoreSimulator/Devices/F578F08D-BEA1-4A56-8A4B-C92B040FBA94/data/Library/Preferences/com.apple.Accessibility.plist: existed=true, beforeSha256=0c85a9ace2ad2c1be37a09a2ceea94fb786d4e163b4c181307bc991038a3b514, afterSha256=4a3b607b80fbb5ec36bfe2b91ca4f28e7c993bce16e93ca3987cc7c56410e2c3
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

- public-macos-ax warm acquisition missed the 75/150 ms target.
- private-coresimulator-ax protocol probe returned unsupported-mechanism/private-tool-unavailable.

## Next interface boundary

- Keep any future bridge behind the #2190 acquisition adapter and preserve raw facts until a separate GO evidence run proves fidelity, lifecycle, and latency.

## Production boundary

- No production backend selection, fallback, runner-demand, open/relaunch, proxy, XCTest interaction, or public CLI changes were made.
- A production bridge should not start until this report has a GO result; this run is the #2192 boundary.
