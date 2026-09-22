# iOS snapshot convergence benchmark

- Status: **completed**
- Revision: 7c434b575837e3291c51315bf9bb8b54c8ce7568
- Host: MacBook Pro (Mac16,8; Apple M4 Pro, 12 cores)
- Target: bench-2188-final (5FEADD02-98E4-4F01-861C-07003C1A3291, com.apple.CoreSimulator.SimRuntime.iOS-26-2)
- Generated: 2026-09-21T20:02:38.671Z

| State | Screen | Transport | Execution | N | Wall median | Wall p95 | Daemon median | Response median | Failures |
|---|---|---|---|---:|---:|---:|---:|---:|---:|
| warm | quiet | proxy | persistent-client | 20 | 102.9 | 109.9 | 94.0 | 1843.0 | 0 |
| warm | quiet | proxy | fresh-process-cli | 20 | 183.8 | 196.2 | 93.0 | 1841.0 | 0 |
| warm | list | proxy | persistent-client | 20 | 214.4 | 230.7 | 205.0 | 8869.0 | 0 |
| warm | list | proxy | fresh-process-cli | 20 | 304.5 | 315.8 | 208.0 | 8869.0 | 0 |
| warm | nested-scroll | proxy | persistent-client | 20 | 179.4 | 283.4 | 171.0 | 5784.0 | 0 |
| warm | nested-scroll | proxy | fresh-process-cli | 20 | 260.2 | 299.2 | 168.0 | 5787.0 | 0 |
| warm | alert | proxy | persistent-client | 20 | 148.4 | 154.1 | 140.0 | 7961.0 | 0 |
| warm | alert | proxy | fresh-process-cli | 20 | 240.7 | 251.6 | 147.0 | 7961.0 | 0 |
| warm | system-surface | proxy | persistent-client | 20 | 127.9 | 159.7 | 119.0 | 5758.0 | 0 |
| warm | system-surface | proxy | fresh-process-cli | 20 | 217.3 | 246.0 | 125.0 | 5758.0 | 0 |
| warm | xctest-stress | proxy | persistent-client | 20 | 135.8 | 149.7 | 128.0 | 7252.0 | 0 |
| warm | xctest-stress | proxy | fresh-process-cli | 20 | 228.6 | 235.2 | 139.0 | 7252.0 | 0 |
| warm | quiet | proxy | persistent-client | 20 | 157.6 | 164.2 | 101.0 | 1842.0 | 0 |
| warm | quiet | proxy | fresh-process-cli | 20 | 293.1 | 300.6 | 105.0 | 1844.0 | 0 |
| warm | list | proxy | persistent-client | 20 | 280.4 | 292.0 | 222.0 | 8869.0 | 0 |
| warm | list | proxy | fresh-process-cli | 20 | 415.5 | 429.1 | 221.0 | 8869.0 | 0 |
| warm | nested-scroll | proxy | persistent-client | 20 | 239.9 | 250.6 | 183.0 | 5785.0 | 0 |
| warm | nested-scroll | proxy | fresh-process-cli | 20 | 376.8 | 392.2 | 182.0 | 5785.0 | 0 |
| warm | alert | proxy | persistent-client | 20 | 203.2 | 221.5 | 148.0 | 7961.0 | 0 |
| warm | alert | proxy | fresh-process-cli | 20 | 343.4 | 356.7 | 150.0 | 7961.0 | 0 |
| warm | system-surface | proxy | persistent-client | 20 | 183.3 | 200.8 | 127.0 | 5758.0 | 0 |
| warm | system-surface | proxy | fresh-process-cli | 20 | 319.3 | 336.4 | 133.0 | 5758.0 | 0 |
| warm | xctest-stress | proxy | persistent-client | 20 | 197.3 | 208.7 | 140.0 | 7252.0 | 0 |
| warm | xctest-stress | proxy | fresh-process-cli | 20 | 339.6 | 353.2 | 148.0 | 7252.0 | 0 |
| warm | quiet | proxy | persistent-client | 20 | 281.9 | 303.0 | 104.0 | 1842.0 | 0 |
| warm | quiet | proxy | fresh-process-cli | 20 | 555.6 | 569.7 | 116.0 | 1840.0 | 0 |
| warm | list | proxy | persistent-client | 20 | 407.8 | 437.1 | 227.0 | 8838.0 | 0 |
| warm | list | proxy | fresh-process-cli | 20 | 691.4 | 708.9 | 236.0 | 8838.0 | 0 |
| warm | nested-scroll | proxy | persistent-client | 20 | 380.8 | 432.7 | 199.0 | 5785.0 | 0 |
| warm | nested-scroll | proxy | fresh-process-cli | 20 | 642.7 | 667.0 | 195.0 | 5784.0 | 0 |
| warm | alert | proxy | persistent-client | 20 | 350.9 | 361.8 | 169.0 | 7961.0 | 0 |
| warm | alert | proxy | fresh-process-cli | 20 | 615.3 | 626.3 | 170.0 | 7961.0 | 0 |
| warm | system-surface | proxy | persistent-client | 20 | 329.8 | 346.5 | 150.0 | 5758.0 | 0 |
| warm | system-surface | proxy | fresh-process-cli | 20 | 595.2 | 611.2 | 152.0 | 5758.0 | 0 |
| warm | xctest-stress | proxy | persistent-client | 20 | 314.0 | 344.5 | 134.0 | 7252.0 | 0 |
| warm | xctest-stress | proxy | fresh-process-cli | 20 | 562.4 | 586.0 | 128.0 | 7252.0 | 0 |

## Package size

Not measured.

## Deep-button control

- Fixture artifact: deep-button-fixture.v1.json (depth 72)
- Red control: pnpm bench:ios-snapshot:deep-button -- --rule invalid-shallow (exit 1)
  - AssertionError: changed descendant was omitted by shallow observation; no-effect claim is invalid.
- Safe control: pnpm bench:ios-snapshot:deep-button -- --rule safe-full (exit 0)
  - full observation changed and includes the changed descendant.
