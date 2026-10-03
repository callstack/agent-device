# iOS Simulator AX bridge corrected evidence

- Decision: **GO**
- Interpretation: **maintainer-corrected**
- Revision: 44995806ea3be09f3c48ceac50ac3cab18462c35 (detached)
- Target: ad-2237-axbridge (8CDB4DF1-3A3E-4FB1-AF89-B3D3A17647D5, com.apple.CoreSimulator.SimRuntime.iOS-26-2)
- Generated: 2026-09-03T20:40:27.697Z
- Immutable broad raw artifact: `evidence/ios-snapshot/44995806ea:ios-simulator-ax-bridge-broad-268a90275.json.gz` (SHA-256 `309f974b1dcb90768548a189f6af58b493b5d7b9d56a5bfad060d4335139eb7b`; original NO-GO; interpretation superseded to stretch-only; host client persistent-in-repository-reader)
- Narrow targeted raw artifact: `evidence/ios-snapshot/44995806ea:ios-simulator-ax-bridge-targeted-44995806ea.json.gz` (SHA-256 `3440d066cb7eea33c4715fece838b5185c5d209694b097e54f5536d48d4984ad`; host client node-direct-socket)
- Corrected raw report: `evidence/ios-snapshot/44995806ea:ios-simulator-ax-bridge-corrected-44995806ea.json.gz` (SHA-256 `0a34a84402e85154e177adef5122101b26bfd04d74714a0a9b6f0795270edc41`)
- Host at generation: load average 4.84 on 12 cores

The broad raw corpus is preserved unchanged. Its old NO-GO used readiness-inclusive first-look and stretch thresholds; this report evaluates the corrected hard contract. The broad warm cells remain conservative upper bounds around the same in-Simulator reader. Relaunch uses the new Node-direct corpus below and does not rely on the legacy relaunch samples.

## Evaluated guest mechanism

- Guest reader: idb v1.5.2 `Resources/SimulatorFrameworkBridge` (observed SHA-256 `3545621d2dc98de32879ebac55e8b0c33dc8eb7cc2bfbc2d0d2d21a002c8de58`; required SHA-256 `3545621d2dc98de32879ebac55e8b0c33dc8eb7cc2bfbc2d0d2d21a002c8de58`) from `idb-companion.macos-arm64.tar.gz` (SHA-256 `f17b718a513931705542a7fbfa9cfc11895ee191562c9ffd2343cf7f8254bc08`).
- Transport: xcrun simctl spawn <udid> SimulatorFrameworkBridge accessibility serve <socket> --idle-timeout 300 --exit-on-disconnect true; UNIX socket frames are a 4-byte big-endian length + JSON.
- Traversal: describe with snapshotTree=true (one XCTest snapshot fetch per read) and automationMode=true asserted per request; no idb_companion, gRPC, or Python client.

## Hard gates

| Gate | Status | Target | Evidence |
|---|---|---|---|
| warm | **PASS** | p50 <300 ms and p95 <500 ms per screen | 6/6 warm screen cells passed; quiet p50/p95=8.6 ms/9.3 ms ready=1/20; list p50/p95=118.2 ms/120.9 ms ready=1/20; nested-scroll p50/p95=15.1 ms/15.8 ms ready=1/20; alert p50/p95=41.6 ms/43.3 ms ready=1/20; system-surface p50/p95=37.2 ms/39.6 ms ready=1/20; xctest-stress p50/p95=39.6 ms/41.1 ms ready=1/20 |
| relaunch | **PASS** | p95 <500 ms per screen after independently observed new-generation readiness | 6/6 relaunch screen cells passed; quiet p50/p95=77.4 ms/133.9 ms ready=20/20; list p50/p95=193.4 ms/234.7 ms ready=20/20; nested-scroll p50/p95=84.5 ms/93.3 ms ready=20/20; alert p50/p95=113.7 ms/124.0 ms ready=20/20; system-surface p50/p95=108.9 ms/116.6 ms ready=20/20; xctest-stress p50/p95=117.4 ms/126.0 ms ready=20/20; 120/120 Node-direct samples across 6/6 screens |
| nonresidentBootstrap | **PASS** | nonresident companion + reader bootstrap and first usable tree p95 <2,000 ms | 5/5 usable trees; p95=1136.6 ms; the timer covered guest spawn, socket connect, and the first tree after a throwaway probe observed the relaunched app's readiness (readiness p95=1220.6 ms), with no resident bridge, xcodebuild, XCTest, or agent-device runner in the timed path |
| boundedResources | **PASS** | guest CPU <=2000 ms and RSS <=268435456 bytes per successful read | 129/129 successful reads measured within bounds; max CPU=220.0 ms; max RSS=89407488 bytes |
| liveRecovery | **PASS** | live crash, timeout, cancellation, and honest target-generation handling | 4/4 probes returned a typed failure or typed unavailable-generation residue and a usable recovered response |
| hierarchy | **PASS** | structural hierarchy acquired with typed truncation, or its absence typed as residue | nested tree with traversal depth 29 in 5/5 samples; truncated=false |
| preferenceControl | **PASS** | task-owned Simulator accessibility preferences applied preboot and restored | applied=true; restored=true; enabled keys=AutomationEnabled, IgnoreAXServerEntitlements; fixture launch compatible=true |

## Readiness boundary and candidate-owned latency

Warm and relaunch timing starts at bridge acquisition after fixture/app readiness admission. Every relaunch row comes from the Node-direct route and is paired with a separate probe that observed the exact relaunched process generation and expected screen anchor. The old first-look value includes Simulator, app, daemon, and runner costs.

| State | Screen | Samples | Readable | Ready generation | Candidate p50/p95 ms | Readiness p95 ms | Old first-look p95 ms | Generations |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| warm | quiet | 20 | 20 | 1 | 8.6/9.3 | 0.0 | 9.3 | 1 |
| warm | list | 20 | 20 | 1 | 118.2/120.9 | 0.0 | 120.9 | 1 |
| warm | nested-scroll | 20 | 20 | 1 | 15.1/15.8 | 0.0 | 15.8 | 1 |
| warm | alert | 20 | 20 | 1 | 41.6/43.3 | 0.0 | 43.3 | 1 |
| warm | system-surface | 20 | 20 | 1 | 37.2/39.6 | 0.0 | 39.6 | 1 |
| warm | xctest-stress | 20 | 20 | 1 | 39.6/41.1 | 0.0 | 41.1 | 1 |
| relaunch | quiet | 20 | 20 | 20 | 77.4/133.9 | 1090.5 | 1174.6 | 20 |
| relaunch | list | 20 | 20 | 20 | 193.4/234.7 | 1180.5 | 1374.0 | 20 |
| relaunch | nested-scroll | 20 | 20 | 20 | 84.5/93.3 | 1111.3 | 1208.6 | 20 |
| relaunch | alert | 20 | 20 | 20 | 113.7/124.0 | 1136.9 | 1283.5 | 20 |
| relaunch | system-surface | 20 | 20 | 20 | 108.9/116.6 | 1114.5 | 1224.1 | 20 |
| relaunch | xctest-stress | 20 | 20 | 20 | 117.4/126.0 | 1122.3 | 1244.3 | 20 |

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

- 5/5 usable trees; p95=1136.6 ms; the timer covered guest spawn, socket connect, and the first tree after a throwaway probe observed the relaunched app's readiness (readiness p95=1220.6 ms), with no resident bridge, xcodebuild, XCTest, or agent-device runner in the timed path.
- 129/129 successful reads measured within bounds; max CPU=220.0 ms; max RSS=89407488 bytes.
- The timed boundary begins with no resident bridge and ends at the first usable guest tree. Before each timer the fixture app was relaunched and a throwaway probe bridge polled until the new generation answered with a tree (readiness), then exited.

| Sample | Duration ms | CPU ms | RSS MiB | Usable tree | Nodes | Depth | Generation | Readiness ms | Attempts | Host load |
|---:|---:|---:|---:|---|---:|---:|---|---:|---:|---:|
| 1 | 1095.6 | 220.0 | 77.1 | true | 155 | 29 | pid:43541 | 1171 | 1 | 21.27 |
| 2 | 1071.2 | 210.0 | 77.5 | true | 155 | 29 | pid:44026 | 1080 | 1 | 23.17 |
| 3 | 1094.4 | 200.0 | 78.5 | true | 155 | 29 | pid:44524 | 1221 | 1 | 24.33 |
| 4 | 1043.5 | 220.0 | 77.9 | true | 155 | 29 | pid:45028 | 1119 | 1 | 22.17 |
| 5 | 1136.6 | 210.0 | 77.4 | true | 155 | 29 | pid:45518 | 1202 | 1 | 20.71 |

## Live candidate recovery

- 4/4 probes returned a typed failure or typed unavailable-generation residue and a usable recovered response.

| Operation | Observed failure | Recovery response | Recovered tree |
|---|---|---|---|
| process-crash | process-crash/guest-exited | ok | 135 nodes |
| timeout | timeout/batch-duration-limit | ok | 135 nodes |
| cancelled | cancelled/abort-signal | ok | 135 nodes |
| stale-generation | stale-generation/target-generation-mismatch | ok | 135 nodes |

## Hierarchy

- nested tree with traversal depth 29 in 5/5 samples; truncated=false.
- Observed traversal depth: 29; depth complete: **true**; interpretation: nested-tree.

## Simulator preference control

- applied=true; restored=true; enabled keys=AutomationEnabled, IgnoreAXServerEntitlements; fixture launch compatible=true.
- The broad capture applied its accessibility preference changes only to the disposable benchmark Simulator before boot, verified fixture launch compatibility, and restored the prior preference files and Simulator state afterward.

## Private-interface compatibility risk

- SimulatorFrameworkBridge and its accessibility wire protocol are private idb/Apple implementation details with no compatibility guarantee.
- Control: Pin the official idb release and observed guest SHA-256, keep this route Simulator-only behind the acquisition adapter, and re-run this verifier for every idb, Xcode, or Simulator runtime change before production adoption.

## Stretch findings

- Original broad-run finding: guest-simulator-framework-bridge cold-cold first look missed the 5 second target.
- Original broad-run finding: guest-simulator-framework-bridge cold prepared first look missed the 1.5 second target.
- Original broad-run finding: guest-simulator-framework-bridge warm/list acquisition missed the 75/150 ms target.
- Original broad-run finding: guest-simulator-framework-bridge relaunch first look missed the 250 ms target.
- Cold and cold-cold first-look measurements include Simulator, app, daemon, and runner readiness costs; they are diagnostics, not candidate-owned hard gates.
- The former warm 75/150 ms and relaunch 250 ms thresholds are stretch findings under the corrected contract.
- Nonresident bootstrap samples were taken on a host with 1-minute load average 4.84 on 12 cores; per-sample load is recorded with each sample.

## Production boundary

- No production backend selection, fallback, runner-demand, open/relaunch, proxy, XCTest interaction, or public CLI changes were made.
- The corrected result is evidence for the #2192 decision boundary only; it does not start production routing.
