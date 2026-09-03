# iOS Simulator AX bridge corrected evidence

- Decision: **GO**
- Interpretation: **maintainer-corrected**
- Revision: 999920fa55098f11eb5ba1f9d39f9cb3cec208e3 (review-2237)
- Target: ad-2237-axbridge (8CDB4DF1-3A3E-4FB1-AF89-B3D3A17647D5, com.apple.CoreSimulator.SimRuntime.iOS-26-2)
- Generated: 2026-09-03T06:04:19.830Z
- Immutable broad raw artifact: `docs/evidence/ios-simulator-ax-bridge-2026-09-01-final.json.gz` (original NO-GO; interpretation superseded to stretch-only; host client persistent-in-repository-reader)
- Superseded targeted raw artifact: `docs/evidence/ios-simulator-ax-bridge-2026-09-02-targeted-python-prototype.json.gz` (persistent-in-repository-reader (idb_companion + Python idb client); its bootstrap and recovery samples raced app readiness and shared one wedged companion, so they measured the prototype packaging, not the mechanism)
- Narrow targeted raw artifact: `docs/evidence/ios-simulator-ax-bridge-2026-09-02-targeted.json.gz` (host client node-direct-socket)
- Host at generation: load average 13.75 on 12 cores

The broad run is preserved unchanged. Its old NO-GO was caused by readiness-inclusive first-look and stretch thresholds; this report evaluates the corrected hard contract. Warm and relaunch cells come from the broad run, whose host client was the idb companion plus a Python reader; the in-Simulator reader and the read it performs are the same mechanism the Node-direct targeted evidence uses, and the host client only adds latency, so those cells bound the mechanism from above.

## Evaluated guest mechanism

- Guest reader: idb v1.5.2 `Resources/SimulatorFrameworkBridge` (SHA-256 `3545621d2dc98de32879ebac55e8b0c33dc8eb7cc2bfbc2d0d2d21a002c8de58`) from `idb-companion.macos-arm64.tar.gz` (SHA-256 `f17b718a513931705542a7fbfa9cfc11895ee191562c9ffd2343cf7f8254bc08`).
- Transport: xcrun simctl spawn <udid> SimulatorFrameworkBridge accessibility serve <socket> --idle-timeout 300 --exit-on-disconnect true; UNIX socket frames are a 4-byte big-endian length + JSON.
- Traversal: describe with snapshotTree=true (one XCTest snapshot fetch per read) and automationMode=true asserted per request; no idb_companion, gRPC, or Python client.

## Hard gates

| Gate | Status | Target | Evidence |
|---|---|---|---|
| warm | **PASS** | p50 <300 ms and p95 <500 ms per screen | 6/6 warm screen cells passed; quiet p50/p95=8.6 ms/9.3 ms ready=20/20; list p50/p95=118.2 ms/120.9 ms ready=20/20; nested-scroll p50/p95=15.1 ms/15.8 ms ready=20/20; alert p50/p95=41.6 ms/43.3 ms ready=20/20; system-surface p50/p95=37.2 ms/39.6 ms ready=20/20; xctest-stress p50/p95=39.6 ms/41.1 ms ready=20/20 |
| relaunch | **PASS** | p95 <500 ms per screen after observed new-generation app readiness | 6/6 relaunch screen cells passed; quiet p50/p95=8.9 ms/9.6 ms ready=20/20; list p50/p95=119.2 ms/121.1 ms ready=20/20; nested-scroll p50/p95=15.4 ms/16.5 ms ready=20/20; alert p50/p95=41.1 ms/42.7 ms ready=20/20; system-surface p50/p95=37.3 ms/39.5 ms ready=20/20; xctest-stress p50/p95=40.4 ms/42.6 ms ready=20/20 |
| nonresidentBootstrap | **PASS** | nonresident companion + reader bootstrap and first usable tree p95 <2,000 ms | 5/5 usable trees; p95=1136.2 ms; the timer covered guest spawn, socket connect, and the first tree after a throwaway probe observed the relaunched app's readiness (readiness p95=1333.2 ms), with no resident bridge, xcodebuild, XCTest, or agent-device runner in the timed path |
| liveRecovery | **PASS** | live crash, timeout, cancellation, and honest target-generation handling | 4/4 probes returned a typed failure or typed unavailable-generation residue and a usable recovered response |
| hierarchy | **PASS** | structural hierarchy acquired with typed truncation, or its absence typed as residue | nested tree with traversal depth 29 in 5/5 samples; truncated=false |

## Readiness boundary and candidate-owned latency

Warm and relaunch timing starts at the bridge acquisition after fixture/app readiness admission. Relaunch readiness is recorded separately; the old first-look value includes Simulator, app, daemon, and runner costs.

| State | Screen | Samples | Readable | Ready generation | Candidate p50/p95 ms | Readiness p95 ms | Old first-look p95 ms | Generations |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| warm | quiet | 20 | 20 | 20 | 8.6/9.3 | 0.0 | 9.3 | 1 |
| warm | list | 20 | 20 | 20 | 118.2/120.9 | 0.0 | 120.9 | 1 |
| warm | nested-scroll | 20 | 20 | 20 | 15.1/15.8 | 0.0 | 15.8 | 1 |
| warm | alert | 20 | 20 | 20 | 41.6/43.3 | 0.0 | 43.3 | 1 |
| warm | system-surface | 20 | 20 | 20 | 37.2/39.6 | 0.0 | 39.6 | 1 |
| warm | xctest-stress | 20 | 20 | 20 | 39.6/41.1 | 0.0 | 41.1 | 1 |
| relaunch | quiet | 20 | 20 | 20 | 8.9/9.6 | 4390.1 | 4399.3 | 1 |
| relaunch | list | 20 | 20 | 20 | 119.2/121.1 | 5061.4 | 5177.9 | 1 |
| relaunch | nested-scroll | 20 | 20 | 20 | 15.4/16.5 | 5078.9 | 5093.8 | 1 |
| relaunch | alert | 20 | 20 | 20 | 41.1/42.7 | 4418.9 | 4461.2 | 1 |
| relaunch | system-surface | 20 | 20 | 20 | 37.3/39.5 | 4976.2 | 5013.4 | 1 |
| relaunch | xctest-stress | 20 | 20 | 20 | 40.4/42.6 | 4463.5 | 4503.0 | 1 |

## Cold diagnostics

Cold and cold-cold first-look measurements remain visible for diagnosis, but are excluded from the candidate-owned hard verdict because they combine environment and readiness boundaries with bridge work.

| State | Screen | Preparation p95 ms | First-look p95 ms | Interpretation |
|---|---|---:|---:|---|
| cold-cold | quiet | 16151.2 | 16575.5 | excluded runner/app readiness costs |
| cold-cold | list | 19475.9 | 20062.0 | excluded runner/app readiness costs |
| cold-cold | nested-scroll | 18561.5 | 19089.0 | excluded runner/app readiness costs |
| cold-cold | alert | 17112.3 | 17549.4 | excluded runner/app readiness costs |
| cold-cold | system-surface | 18355.9 | 18866.3 | excluded runner/app readiness costs |
| cold-cold | xctest-stress | 16930.2 | 17368.5 | excluded runner/app readiness costs |
| cold | quiet | 7138.6 | 7147.0 | excluded runner/app readiness costs |
| cold | list | 6985.7 | 7104.5 | excluded runner/app readiness costs |
| cold | nested-scroll | 6930.9 | 6947.1 | excluded runner/app readiness costs |
| cold | alert | 6855.4 | 6895.5 | excluded runner/app readiness costs |
| cold | system-surface | 7145.6 | 7181.9 | excluded runner/app readiness costs |
| cold | xctest-stress | 6918.1 | 6959.1 | excluded runner/app readiness costs |

## Nonresident bootstrap

- 5/5 usable trees; p95=1136.2 ms; the timer covered guest spawn, socket connect, and the first tree after a throwaway probe observed the relaunched app's readiness (readiness p95=1333.2 ms), with no resident bridge, xcodebuild, XCTest, or agent-device runner in the timed path.
- The timed boundary begins with no resident bridge and ends at the first usable guest tree. Before each timer the fixture app was relaunched and a throwaway probe bridge polled until the new generation answered with a tree (readiness), then exited.

| Sample | Duration ms | Usable tree | Failure | Nodes | Depth | Generation | Readiness ms | Readiness attempts | Host load |
|---:|---:|---|---|---:|---:|---|---:|---:|---:|
| 1 | 1080.8 | true | none/none | 155 | 29 | pid:68714 | 1333 | 1 | 11.66 |
| 2 | 1136.2 | true | none/none | 155 | 29 | pid:69066 | 1172 | 1 | 13.4 |
| 3 | 1055.3 | true | none/none | 155 | 29 | pid:69393 | 1162 | 1 | 13.34 |
| 4 | 1049.9 | true | none/none | 155 | 29 | pid:69892 | 1169 | 1 | 13.21 |
| 5 | 1043.5 | true | none/none | 155 | 29 | pid:70202 | 1101 | 1 | 13.35 |

## Live candidate recovery

- 4/4 probes returned a typed failure or typed unavailable-generation residue and a usable recovered response.

| Operation | Observed failure | Recovery response | Recovered tree |
|---|---|---|---|
| process-crash | process-crash/guest-exited | ok | 155 nodes |
| timeout | timeout/batch-duration-limit | ok | 155 nodes |
| cancelled | cancelled/abort-signal | ok | 155 nodes |
| stale-generation | stale-generation/target-generation-mismatch | ok | 155 nodes |

## Hierarchy

- nested tree with traversal depth 29 in 5/5 samples; truncated=false.
- Observed traversal depth: 29; depth complete: **true**; interpretation: nested-tree.

## Stretch findings

- Original broad-run finding: guest-simulator-framework-bridge cold-cold first look missed the 5 second target.
- Original broad-run finding: guest-simulator-framework-bridge cold prepared first look missed the 1.5 second target.
- Original broad-run finding: guest-simulator-framework-bridge warm/list acquisition missed the 75/150 ms target.
- Original broad-run finding: guest-simulator-framework-bridge relaunch first look missed the 250 ms target.
- Cold and cold-cold first-look measurements include Simulator, app, daemon, and runner readiness costs; they are diagnostics, not candidate-owned hard gates.
- The former warm 75/150 ms and relaunch 250 ms thresholds are stretch findings under the corrected contract.
- Nonresident bootstrap samples were taken on a host with 1-minute load average 13.75 on 12 cores; per-sample load is recorded with each sample.

## Production boundary

- No production backend selection, fallback, runner-demand, open/relaunch, proxy, XCTest interaction, or public CLI changes were made.
- The corrected result is evidence for the #2192 decision boundary only; it does not start production routing.
