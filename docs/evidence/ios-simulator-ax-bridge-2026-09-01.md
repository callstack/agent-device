# iOS Simulator AX bridge spike

- Decision: **NO-GO**
- Status: **completed**
- Revision: 6d561b372088b7d13a908565f0255a6d77ff87ce (takeover/2209-valid-evidence)
- Target: AgentDevice-2209-Takeover (F578F08D-BEA1-4A56-8A4B-C92B040FBA94, com.apple.CoreSimulator.SimRuntime.iOS-26-2)
- Generated: 2026-09-01T12:14:03.698Z
- Corpus: states=warm, screens=quiet, list, samples=20

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
| public-macos-ax | public macOS ApplicationServices AX | observed in successful cells | not exercised | framed protocol | exact Simulator content surface, but complex trees exceed the latency budget |
| private-coresimulator-ax | external/private CoreSimulator AX tool | failed in cells | not exercised | framed protocol contract only | private interface/tool compatibility |
| xctest-control | #2189 XCTest runner control | observed in successful cells | not exercised | existing runner lifecycle | control, not a host-side AX bridge |

## Raw acquisition and prototype presentation results

| Candidate | State | Screen | N | Acquisition p50/p95 ms | First look p95 ms | Presentation p50/p95 ms | Nodes | Failures |
|---|---|---|---:|---:|---:|---:|---:|---:|
| public-macos-ax | warm | quiet | 20 | 42.9/123.1 | 34430.6/34510.8 | 0.0/0.2 | 4.0 | 0 |
| public-macos-ax | warm | list | 20 | 5002.8/5002.8 | 31035.4/31035.4 | 0.0/1.6 | 114.0 | 16 |
| private-coresimulator-ax | warm | quiet | 20 | 0.1/0.1 | 31115.5/31115.5 | 0.0/0.0 | – | 20 |
| private-coresimulator-ax | warm | list | 20 | 0.0/0.0 | 30479.5/30479.5 | 0.0/0.0 | – | 20 |
| xctest-control | warm | quiet | 20 | 450.3/958.9 | 26852.6/27361.2 | 0.0/0.0 | 4.0 | 0 |
| xctest-control | warm | list | 20 | 569.2/828.8 | 36422.0/36681.6 | 0.0/0.5 | 31.0 | 0 |

Every acquisition sample retains timing, resource, readiness, and failure evidence; the first successful sample in each cell also retains one raw node-tree exemplar with viewport, target generation, truncation, and residue. Presentation samples measure only construction of the #2190 acquired carrier; they do not apply visibility, hittability, scope, depth, or semantic compaction.

## Direct protocol probes

- public-macos-ax/protocol-probe:public-macos-ax: ok=true, failure=none, code=none, nodes=114, duration=2907.0 ms, CPU=33.4 ms, memory=11632640 B, response=28586 B
- private-coresimulator-ax/protocol-probe:private-coresimulator-ax: ok=false, failure=unsupported-mechanism, code=private-tool-unavailable, nodes=0, duration=0.0 ms, CPU=– ms, memory=– B, response=0 B
- stderr public-macos-ax/protocol-probe:public-macos-ax: [ios-ax-spike] capture id=protocol-probe:public-macos-ax candidate=public-macos-ax screen=quiet
- stderr private-coresimulator-ax/protocol-probe:private-coresimulator-ax: empty

## Independent positive-control evidence

- Invalid shallow rule: exit=1; command=pnpm bench:ios-snapshot:deep-button -- --rule invalid-shallow; assertion=AssertionError: changed descendant was omitted by shallow observation; no-effect claim is invalid.
- Safe full rule: exit=0; command=pnpm bench:ios-snapshot:deep-button -- --rule safe-full; assertion=full observation changed and includes the changed descendant.

## Preference experiment

- Applied: **false**
- Restored: **not required**
- Simulator state before experiment: Booted
- No private/preboot preference keys were applied in this run.

## Lifecycle, cancellation, and recovery

- Source: framed-protocol-fixture
- Process crash: process-crash; recovered=true
- Timeout: timeout; recovered=true
- Cancellation: cancelled; recovered=true
- Stale generation: stale-generation; recovered=true

## Decision rationale

- public-macos-ax did not complete the required corpus (22 cells missing).
- public-macos-ax warm/list did not produce 20 readable samples.
- public-macos-ax warm acquisition missed the 75/150 ms target.
- private-coresimulator-ax protocol probe returned unsupported-mechanism/private-tool-unavailable.
- private-coresimulator-ax did not complete the required corpus (22 cells missing).
- private-coresimulator-ax warm/quiet did not produce 20 readable samples.
- private-coresimulator-ax warm/quiet has unreadable or empty first-tree evidence.
- private-coresimulator-ax warm/list did not produce 20 readable samples.
- private-coresimulator-ax warm/list has unreadable or empty first-tree evidence.
- The private CoreSimulator AX mechanism has no configured tool on this host.

## Next interface boundary

- Keep any future bridge behind the #2190 acquisition adapter and preserve raw facts until a separate GO evidence run proves fidelity, lifecycle, and latency.

## Production boundary

- No production backend selection, fallback, runner-demand, open/relaunch, proxy, XCTest interaction, or public CLI changes were made.
- A production bridge should not start until this report has a GO result; this run is the #2192 boundary.
