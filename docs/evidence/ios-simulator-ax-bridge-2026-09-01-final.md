# iOS Simulator AX bridge spike

- Decision: **NO-GO**
- Status: **completed**
- Revision: 03f5a8ebe0bc3fa58c94a2c73e8d8ee6bda346ef (codex/2192-guest-bridge-evidence)
- Target: bench-golden-v2 (7E76ECA9-D40C-4833-A711-F870F8CE9363, com.apple.CoreSimulator.SimRuntime.iOS-27-0)
- Generated: 2026-09-02T14:49:10.733Z
- Corpus: states=cold-cold, cold, warm, relaunch, screens=quiet, list, nested-scroll, alert, system-surface, xctest-stress, samples=20
- Corpus coverage: **full**

## Evaluated guest mechanism

- Implementation: **idb v1.5.2** using `axbridge-persistent` and `default` output.
- Companion: `idb-companion.macos-arm64.tar.gz` (SHA-256 `f17b718a513931705542a7fbfa9cfc11895ee191562c9ffd2343cf7f8254bc08`).
- CLI: `idb-cli-1.5.2.arm64_tahoe.bottle.tar.gz` (SHA-256 `ce574aa28ecf3e33a5249d60578a1dc2f609ec82f7e240907b6d9fde6251dda6`).
- Host client: **persistent-in-repository-reader**; the companion and client remain outside the distributed package.

## Environment and limits

- Node: v26.7.0
- pnpm: 11.25.0
- Xcode: Xcode 27.0; Build version 27A5252f
- simctl: @(#)PROGRAM:simctl  PROJECT:CoreSimulator-1171.6
- OS: darwin 27.0.0; arch=arm64
- Bounds: request=65536 B, response=4194304 B, nodes=1500, traversal=12, CPU=2000 ms, memory=268435456 B, duration=5000 ms

## Candidate fidelity and limitation matrix

| Candidate | Mechanism | App surface | System surface | Lifecycle | Main limitation |
|---|---|---|---|---|---|
| guest-simulator-framework-bridge | idb SimulatorFrameworkBridge guest via axbridge-persistent | observed in successful cells | observed in successful cells | persistent companion + typed reader | provider exposes a flat raw element response |
| xctest-control | #2189 XCTest runner control | observed in successful cells | observed in successful cells | existing runner lifecycle | control, not a host-side AX bridge |

## Raw acquisition and prototype presentation results

| Candidate | State | Screen | Readable/attempted | Wall p50/p95 ms | Gated duration p50/p95 ms | First look p95 ms | Presentation p50/p95 ms | Nodes | Failures |
|---|---|---|---:|---:|---:|---:|---:|---:|---:|
| guest-simulator-framework-bridge | cold-cold | quiet | 20/20 | 417.3/563.5 | 413.1/562.6 | 15358.5/16575.5 | 0.2/0.3 | 25.0 | 0 |
| guest-simulator-framework-bridge | cold-cold | list | 20/20 | 594.0/871.2 | 591.9/868.3 | 17855.1/20062.0 | 4.1/6.5 | 283.0 | 0 |
| guest-simulator-framework-bridge | cold-cold | nested-scroll | 20/20 | 442.6/564.4 | 441.5/563.2 | 16674.5/19089.0 | 0.4/0.7 | 58.0 | 0 |
| guest-simulator-framework-bridge | cold-cold | alert | 20/20 | 404.2/465.7 | 402.4/463.8 | 15240.0/17549.4 | 1.7/2.9 | 149.0 | 0 |
| guest-simulator-framework-bridge | cold-cold | system-surface | 20/20 | 522.8/658.3 | 521.7/656.8 | 17654.2/18866.3 | 1.7/3.4 | 167.0 | 0 |
| guest-simulator-framework-bridge | cold-cold | xctest-stress | 20/20 | 488.4/670.1 | 486.8/668.9 | 16316.8/17368.5 | 1.4/2.5 | 139.0 | 0 |
| guest-simulator-framework-bridge | cold | quiet | 20/20 | 8.4/9.1 | 7.9/8.4 | 6784.5/7147.0 | 0.0/0.1 | 25.0 | 0 |
| guest-simulator-framework-bridge | cold | list | 20/20 | 117.5/119.9 | 116.0/118.5 | 7044.9/7104.5 | 5.6/7.0 | 283.0 | 0 |
| guest-simulator-framework-bridge | cold | nested-scroll | 20/20 | 15.5/16.2 | 14.5/15.1 | 6853.2/6947.1 | 0.3/0.5 | 58.0 | 0 |
| guest-simulator-framework-bridge | cold | alert | 20/20 | 39.0/42.6 | 38.1/40.9 | 6842.4/6895.5 | 1.6/2.5 | 146.0 | 0 |
| guest-simulator-framework-bridge | cold | system-surface | 20/20 | 37.2/40.3 | 35.6/38.5 | 6963.7/7181.9 | 1.6/2.6 | 167.0 | 0 |
| guest-simulator-framework-bridge | cold | xctest-stress | 20/20 | 40.5/42.7 | 38.9/41.0 | 6882.1/6959.1 | 1.5/1.9 | 139.0 | 0 |
| guest-simulator-framework-bridge | warm | quiet | 20/20 | 8.6/9.3 | 7.9/8.4 | 8.6/9.3 | 0.1/0.1 | 25.0 | 0 |
| guest-simulator-framework-bridge | warm | list | 20/20 | 118.2/120.9 | 115.6/118.8 | 118.2/120.9 | 5.2/6.6 | 283.0 | 0 |
| guest-simulator-framework-bridge | warm | nested-scroll | 20/20 | 15.1/15.8 | 14.2/14.7 | 15.1/15.8 | 0.2/0.3 | 58.0 | 0 |
| guest-simulator-framework-bridge | warm | alert | 20/20 | 41.6/43.3 | 40.2/41.6 | 41.6/43.3 | 1.0/1.9 | 146.0 | 0 |
| guest-simulator-framework-bridge | warm | system-surface | 20/20 | 37.2/39.6 | 35.7/37.9 | 37.2/39.6 | 1.5/2.2 | 167.0 | 0 |
| guest-simulator-framework-bridge | warm | xctest-stress | 20/20 | 39.6/41.1 | 38.1/39.3 | 39.6/41.1 | 1.4/1.8 | 139.0 | 0 |
| guest-simulator-framework-bridge | relaunch | quiet | 20/20 | 8.9/9.6 | 8.2/8.9 | 3654.1/4399.3 | 0.1/0.1 | 25.0 | 0 |
| guest-simulator-framework-bridge | relaunch | list | 20/20 | 119.2/121.1 | 116.7/119.1 | 4515.6/5177.9 | 4.4/6.2 | 283.0 | 0 |
| guest-simulator-framework-bridge | relaunch | nested-scroll | 20/20 | 15.4/16.5 | 14.7/15.5 | 4316.7/5093.8 | 0.1/0.2 | 58.0 | 0 |
| guest-simulator-framework-bridge | relaunch | alert | 20/20 | 41.1/42.7 | 39.5/40.8 | 4380.2/4461.2 | 1.7/2.2 | 146.0 | 0 |
| guest-simulator-framework-bridge | relaunch | system-surface | 20/20 | 37.3/39.5 | 36.3/37.7 | 4882.3/5013.4 | 1.7/2.5 | 167.0 | 0 |
| guest-simulator-framework-bridge | relaunch | xctest-stress | 20/20 | 40.4/42.6 | 39.1/40.7 | 4395.7/4503.0 | 0.9/2.4 | 139.0 | 0 |
| xctest-control | cold-cold | quiet | 20/20 | 163.3/247.5 | 163.2/247.5 | 15611.3/16840.6 | 0.0/0.1 | 6.0 | 0 |
| xctest-control | cold-cold | list | 20/20 | 327.6/429.3 | 327.5/429.1 | 14931.5/16261.8 | 0.2/0.5 | 35.0 | 0 |
| xctest-control | cold-cold | nested-scroll | 20/20 | 209.3/246.3 | 209.0/246.2 | 15016.4/15457.2 | 0.1/0.3 | 25.0 | 0 |
| xctest-control | cold-cold | alert | 20/20 | 213.0/282.6 | 212.9/282.5 | 15491.7/16666.2 | 0.1/0.2 | 30.0 | 0 |
| xctest-control | cold-cold | system-surface | 20/20 | 258.8/356.7 | 258.7/356.5 | 15933.8/16595.8 | 0.1/0.3 | 18.0 | 0 |
| xctest-control | cold-cold | xctest-stress | 20/20 | 235.7/312.0 | 235.6/311.9 | 15948.0/16851.6 | 0.1/0.2 | 29.0 | 0 |
| xctest-control | cold | quiet | 20/20 | 142.3/155.6 | 142.3/155.5 | 6835.4/7037.6 | 0.0/0.0 | 6.0 | 0 |
| xctest-control | cold | list | 20/20 | 300.4/321.7 | 300.3/321.5 | 7159.1/7245.4 | 0.2/0.3 | 35.0 | 0 |
| xctest-control | cold | nested-scroll | 20/20 | 176.3/190.6 | 176.2/190.4 | 6908.5/6974.1 | 0.1/0.2 | 25.0 | 0 |
| xctest-control | cold | alert | 20/20 | 203.1/213.7 | 203.0/213.4 | 6966.8/7120.8 | 0.1/0.2 | 30.0 | 0 |
| xctest-control | cold | system-surface | 20/20 | 211.6/218.4 | 211.5/218.3 | 7108.5/7228.2 | 0.1/0.1 | 18.0 | 0 |
| xctest-control | cold | xctest-stress | 20/20 | 206.1/213.1 | 205.9/213.0 | 7043.2/7106.2 | 0.1/0.2 | 29.0 | 0 |
| xctest-control | warm | quiet | 20/20 | 150.2/155.8 | 150.1/155.7 | 150.2/155.8 | 0.0/0.0 | 6.0 | 0 |
| xctest-control | warm | list | 20/20 | 314.4/321.4 | 314.1/321.2 | 314.4/321.4 | 0.2/0.4 | 35.0 | 0 |
| xctest-control | warm | nested-scroll | 20/20 | 186.2/192.4 | 186.0/192.3 | 186.2/192.4 | 0.1/0.2 | 25.0 | 0 |
| xctest-control | warm | alert | 20/20 | 208.7/215.8 | 208.6/215.7 | 208.7/215.8 | 0.1/0.1 | 30.0 | 0 |
| xctest-control | warm | system-surface | 20/20 | 203.8/218.4 | 203.7/218.4 | 203.8/218.4 | 0.1/0.2 | 18.0 | 0 |
| xctest-control | warm | xctest-stress | 20/20 | 198.5/215.4 | 198.4/215.3 | 198.5/215.4 | 0.1/0.1 | 29.0 | 0 |
| xctest-control | relaunch | quiet | 20/20 | 467.1/482.5 | 467.0/482.4 | 4092.5/4798.6 | 0.0/0.1 | 5.0 | 0 |
| xctest-control | relaunch | list | 20/20 | 467.5/484.7 | 467.4/484.5 | 4836.3/5643.2 | 0.2/0.3 | 32.0 | 0 |
| xctest-control | relaunch | nested-scroll | 20/20 | 467.6/478.0 | 467.4/477.8 | 4761.2/5496.0 | 0.1/0.3 | 26.0 | 0 |
| xctest-control | relaunch | alert | 20/20 | 463.1/478.9 | 463.1/478.7 | 4808.2/4877.2 | 0.1/0.4 | 26.0 | 0 |
| xctest-control | relaunch | system-surface | 20/20 | 464.2/482.9 | 464.1/482.7 | 5243.9/5379.9 | 0.1/0.2 | 20.0 | 0 |
| xctest-control | relaunch | xctest-stress | 20/20 | 470.9/483.4 | 470.8/483.3 | 4914.0/5558.9 | 0.1/0.2 | 26.0 | 0 |

Raw exemplar fidelity (candidate vs XCTest control):
- guest-simulator-framework-bridge quiet: nodes 25/6; depth 0/3; identifiers 3/2.
- guest-simulator-framework-bridge list: nodes 283/35; depth 0/5; identifiers 63/12.
- guest-simulator-framework-bridge nested-scroll: nodes 58/25; depth 0/6; identifiers 11/8.
- guest-simulator-framework-bridge alert: nodes 146/30; depth 0/5; identifiers 21/11.
- guest-simulator-framework-bridge system-surface: nodes 167/18; depth 0/4; identifiers 30/14.
- guest-simulator-framework-bridge xctest-stress: nodes 139/29; depth 0/5; identifiers 23/7.

Every acquisition sample retains timing, resource, readiness, and failure evidence; the first successful sample in each cell also retains one raw node-tree exemplar with viewport, target generation, truncation, and residue. Presentation samples measure only construction of the #2190 acquired carrier; they do not apply visibility, hittability, scope, depth, or semantic compaction.

## Direct protocol probes

- guest-simulator-framework-bridge/protocol-probe:guest-simulator-framework-bridge: ok=false, failure=timeout, code=batch-duration-limit, nodes=0, duration=0.0 ms, CPU=– ms, memory=– B, response=0 B
- stderr guest-simulator-framework-bridge/protocol-probe:guest-simulator-framework-bridge: IDB Companion Built at Sep 1 2026 08:51:20 ⏎ IDB Companion architecture arm64 ⏎ Invoked with args=[/tmp/agent-device-idb-2192-rerun/companion/idb_companion, --udid, 7E76ECA9-D40C-4833-A711-F870F8CE9363, --grpc-domain-sock, /var/folders/pn/0s6xww5x5tj2brz0nrvlx96w0000gn/T/agent-device-guest-yR225B/bridge.sock, --log-level, warning, --idle-shutdown-time, 3600] ⏎ Providing targets across Simulator and Device sets. ⏎ CoreSimulator: Already loaded, skipping ⏎ CoreSimulator: SimDevice has correct path of /Library/Developer ⏎ Loaded All Private Frameworks [CoreSimulator] ⏎ MobileDevice: Loading from /System/Library/PrivateFrameworks/MobileDevice.framework ⏎ MobileDevice: Successfully loaded ⏎ Loaded All Private Frameworks [MobileDevice] ⏎ MobileDevice: Loading from /System/Library/PrivateFrameworks/MobileDevice.framework ⏎ MobileDevice: Successfully loaded ⏎ Loaded All Private Frameworks [MobileDevice] ⏎ Cleaning up UDS if exists ⏎ Starting swift server on unix socket /var/folders/pn/0s6xww5x5tj2brz0nrvlx96w0000gn/T/agent-device-guest-yR225B/bridge.sock ⏎ Swift server started on [UDS]/var/folders/pn/0s6xww5x5tj2brz0nrvlx96w0000gn/T/agent-device-guest-yR225B/bridge.sock ⏎ Companion will shut down after 3600s of inactivity ⏎ Companion will stay alive if target goes offline ⏎ Start of connect ⏎ connect called with: [metadata=[:], localFilePath=/var/folders/pn/0s6xww5x5tj2brz0nrvlx96w0000gn/T/tmp13m33044, unknownFields=UnknownStorage(data: 0 bytes)] ⏎ connect succeeded ⏎ Start of describe ⏎ describe called with: [fetchDiagnostics=false, unknownFields=UnknownStorage(data: 0 bytes)] ⏎ describe succeeded ⏎ Start of accessibility_info ⏎ accessibility_info called with: [format=legacy, marker=, matchKey=label, depth=0, keys=["AXFrame", "AXLabel", "AXValue", "AXUniqueId", "AXEnabled", "AXSelected", "AXFocused", "type", "rol..., backend=axbridgePersistent, profile=false, collectFrameCoverage=false, unknownFields=UnknownStorage(data: 0 bytes), point=nil]

## Independent positive-control evidence

- Invalid shallow rule: exit=1; command=pnpm bench:ios-snapshot:deep-button -- --rule invalid-shallow; assertion=AssertionError: changed descendant was omitted by shallow observation; no-effect claim is invalid.
- Safe full rule: exit=0; command=pnpm bench:ios-snapshot:deep-button -- --rule safe-full; assertion=full observation changed and includes the changed descendant.

## Preference experiment

- Applied: **true**
- Restored: **true**
- Fixture launch compatible: **true**
- Simulator state before experiment: Shutdown
- Private/preboot preference keys are experimental only; they were applied to this shutdown disposable Simulator and the original plist bytes were restored.
- /Users/michal/Library/Developer/CoreSimulator/Devices/7E76ECA9-D40C-4833-A711-F870F8CE9363/data/Library/Preferences/com.apple.Accessibility.plist: existed=true, beforeSha256=d823b0ec1206d6f988374a2ad6f2851e300f82ecb8a9345ed540e288c9c76fa9, afterSha256=3bf49967da1ddaf776cf3eebf005a0c49622d78456ce1f8dd1007fb1ed4f9647
  - Changes: AccessibilityEnabled: false -> true; ApplicationAccessibilityEnabled: 0 -> true; AutomationEnabled: 0 -> true; IgnoreAXServerEntitlements: undefined -> true
- /Users/michal/Library/Developer/CoreSimulator/Devices/7E76ECA9-D40C-4833-A711-F870F8CE9363/data/Library/Preferences/com.apple.UIAutomation.plist: existed=true, beforeSha256=db8995177327a963486dd0607260f0fad74ad10d9dec6c2f5abdbaf0dbd00b2c, afterSha256=db8995177327a963486dd0607260f0fad74ad10d9dec6c2f5abdbaf0dbd00b2c
  - Changes: none

## Lifecycle, cancellation, and recovery

- Source: framed-protocol-fixture
- Process crash: process-crash; recovered=true
- Timeout: timeout; recovered=true
- Cancellation: cancelled; recovered=true
- Stale generation: stale-generation; recovered=true

## Decision rationale

- guest-simulator-framework-bridge cold-cold first look missed the 5 second target.
- guest-simulator-framework-bridge cold prepared first look missed the 1.5 second target.
- guest-simulator-framework-bridge warm/list acquisition missed the 75/150 ms target.
- guest-simulator-framework-bridge relaunch first look missed the 250 ms target.

## Next interface boundary

- Keep any future bridge behind the #2190 acquisition adapter and preserve raw facts until a separate GO evidence run proves fidelity, lifecycle, and latency.

## Production boundary

- No production backend selection, fallback, runner-demand, open/relaunch, proxy, XCTest interaction, or public CLI changes were made.
- A production bridge should not start until this report has a GO result; this run is the #2192 boundary.
