# iOS Simulator AX bridge corrected evidence

- Decision: **NO-GO**
- Interpretation: **maintainer-corrected**
- Revision: eac2c7f409f4148bbeb1af87a55ad74eef54e8fc (codex/2192-guest-bridge-evidence)
- Target: bench-golden-v2 (7E76ECA9-D40C-4833-A711-F870F8CE9363, com.apple.CoreSimulator.SimRuntime.iOS-27-0)
- Generated: 2026-09-02T15:37:43.300Z
- Immutable broad raw artifact: `docs/evidence/ios-simulator-ax-bridge-2026-09-01-final.json.gz` (original NO-GO; interpretation superseded to stretch-only)
- Narrow targeted raw artifact: `docs/evidence/ios-simulator-ax-bridge-2026-09-02-targeted.json.gz`

The broad run is preserved unchanged. Its old NO-GO was caused by readiness-inclusive first-look and stretch thresholds; this report evaluates the corrected hard contract.

## Hard gates

| Gate | Status | Target | Evidence |
|---|---|---|---|
| warm | **PASS** | p50 <300 ms and p95 <500 ms per screen | 6/6 warm screen cells passed; quiet p50/p95=8.6 ms/9.3 ms ready=20/20; list p50/p95=118.2 ms/120.9 ms ready=20/20; nested-scroll p50/p95=15.1 ms/15.8 ms ready=20/20; alert p50/p95=41.6 ms/43.3 ms ready=20/20; system-surface p50/p95=37.2 ms/39.6 ms ready=20/20; xctest-stress p50/p95=39.6 ms/41.1 ms ready=20/20 |
| relaunch | **PASS** | p95 <500 ms per screen after observed new-generation app readiness | 6/6 relaunch screen cells passed; quiet p50/p95=8.9 ms/9.6 ms ready=20/20; list p50/p95=119.2 ms/121.1 ms ready=20/20; nested-scroll p50/p95=15.4 ms/16.5 ms ready=20/20; alert p50/p95=41.1 ms/42.7 ms ready=20/20; system-surface p50/p95=37.3 ms/39.5 ms ready=20/20; xctest-stress p50/p95=40.4 ms/42.6 ms ready=20/20 |
| nonresidentBootstrap | **FAIL** | nonresident companion + reader bootstrap and first usable tree p95 <2,000 ms | 1/5 usable trees; p95=5768.8 ms; timer covered adapter acquireBatch only after app readiness, with no xcodebuild, XCTest, or agent-device runner in the timed path |
| liveRecovery | **FAIL** | live crash, timeout, cancellation, and honest target-generation handling | 0/4 probes returned a typed failure or typed unavailable-generation residue and a usable recovered response |
| hierarchyResidue | **PASS** | missing hierarchy represented as typed provider-pruned depth residue | provider-pruned/depth observed; traversal depth is not treated as complete |

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

- 1/5 usable trees; p95=5768.8 ms; timer covered adapter acquireBatch only after app readiness, with no xcodebuild, XCTest, or agent-device runner in the timed path.
- The timed boundary begins with a nonresident adapter and ends at the first usable guest tree; Simulator/app readiness was established before the timer.

| Sample | Duration ms | Usable tree | Failure | Nodes | Generation |
|---:|---:|---|---|---:|---|
| 1 | 1990.6 | true | none/none | 159 | – |
| 2 | 5718.8 | false | timeout/batch-duration-limit | 0 | – |
| 3 | 5702.4 | false | timeout/batch-duration-limit | 0 | – |
| 4 | 5740.5 | false | timeout/batch-duration-limit | 0 | – |
| 5 | 5768.8 | false | timeout/batch-duration-limit | 0 | – |

## Live candidate recovery

- 0/4 probes returned a typed failure or typed unavailable-generation residue and a usable recovered response.

| Operation | Observed failure | Recovery response | Recovered tree |
|---|---|---|---|
| process-crash | process-crash/persistent-process-exited | failed | 0 nodes |
| timeout | timeout/guest-read-timeout | failed | 0 nodes |
| cancelled | cancelled/abort-signal | failed | 0 nodes |
| stale-generation | timeout/batch-duration-limit | failed | 0 nodes |

## Hierarchy residue

- provider-pruned/depth observed; traversal depth is not treated as complete.
- Observed traversal depth: 0; depth complete: **false**. The guest response is flat and carries typed `provider-pruned/depth` residue.

## Stretch findings

- Original broad-run finding: guest-simulator-framework-bridge cold-cold first look missed the 5 second target.
- Original broad-run finding: guest-simulator-framework-bridge cold prepared first look missed the 1.5 second target.
- Original broad-run finding: guest-simulator-framework-bridge warm/list acquisition missed the 75/150 ms target.
- Original broad-run finding: guest-simulator-framework-bridge relaunch first look missed the 250 ms target.
- Cold and cold-cold first-look measurements include Simulator, app, daemon, and runner readiness costs; they are diagnostics, not candidate-owned hard gates.
- The former warm 75/150 ms and relaunch 250 ms thresholds are stretch findings under the corrected contract.

## Production boundary

- No production backend selection, fallback, runner-demand, open/relaunch, proxy, XCTest interaction, or public CLI changes were made.
- The corrected result is evidence for the #2192 decision boundary only; it does not start production routing.
