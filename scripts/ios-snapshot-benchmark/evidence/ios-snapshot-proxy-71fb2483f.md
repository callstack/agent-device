# iOS snapshot convergence benchmark

- Status: **completed**
- Revision: 71fb2483f30d90e615e949601c836aeebbf450c5
- Host: MacBook Pro (Mac16,8; Apple M4 Pro, 12 cores)
- Target: bench-golden-v2 (7E76ECA9-D40C-4833-A711-F870F8CE9363, com.apple.CoreSimulator.SimRuntime.iOS-27-0)
- Generated: 2026-09-01T17:20:04.211Z

| State | Screen | Transport | Execution | N | Wall median | Wall p95 | Daemon median | Response median | Failures |
|---|---|---|---|---:|---:|---:|---:|---:|---:|
| warm | quiet | proxy | persistent-client | 20 | 273.3 | 1313.9 | 211.0 | 1924.0 | 0 |
| warm | quiet | proxy | fresh-process-cli | 20 | 233.2 | 288.7 | 67.0 | 1919.0 | 0 |
| warm | list | proxy | persistent-client | 20 | 254.1 | 262.5 | 250.0 | 8281.0 | 0 |
| warm | list | proxy | fresh-process-cli | 20 | 430.5 | 523.9 | 269.0 | 8281.0 | 0 |
| warm | nested-scroll | proxy | persistent-client | 20 | 137.7 | 228.9 | 127.0 | 6275.0 | 0 |
| warm | nested-scroll | proxy | fresh-process-cli | 20 | 187.9 | 350.9 | 82.0 | 6272.0 | 0 |
| warm | alert | proxy | persistent-client | 20 | 108.4 | 113.2 | 102.0 | 7168.0 | 0 |
| warm | alert | proxy | fresh-process-cli | 20 | 210.2 | 278.1 | 103.0 | 7167.0 | 0 |
| warm | system-surface | proxy | persistent-client | 20 | 105.0 | 108.4 | 102.0 | 4610.0 | 0 |
| warm | system-surface | proxy | fresh-process-cli | 20 | 209.5 | 238.2 | 110.0 | 4610.0 | 0 |
| warm | xctest-stress | proxy | persistent-client | 20 | 126.8 | 168.7 | 120.0 | 6842.0 | 0 |
| warm | xctest-stress | proxy | fresh-process-cli | 20 | 224.8 | 278.3 | 111.0 | 6841.0 | 0 |
| warm | quiet | proxy | persistent-client | 20 | 561.5 | 927.4 | 60.0 | 1919.0 | 0 |
| warm | quiet | proxy | fresh-process-cli | 20 | 1057.3 | 2038.0 | 57.0 | 1919.0 | 0 |
| warm | list | proxy | persistent-client | 20 | 718.5 | 884.4 | 218.0 | 8281.0 | 0 |
| warm | list | proxy | fresh-process-cli | 20 | 1221.1 | 1494.4 | 220.0 | 8281.0 | 0 |
| warm | nested-scroll | proxy | persistent-client | 20 | 590.4 | 1428.5 | 88.0 | 6272.0 | 0 |
| warm | nested-scroll | proxy | fresh-process-cli | 20 | 1116.1 | 1505.1 | 108.0 | 6275.0 | 0 |
| warm | alert | proxy | persistent-client | 20 | 622.5 | 925.3 | 126.0 | 7167.0 | 0 |
| warm | alert | proxy | fresh-process-cli | 20 | 1112.8 | 1614.4 | 111.0 | 7167.0 | 0 |
| warm | system-surface | proxy | persistent-client | 20 | 537.4 | 895.2 | 112.0 | 4610.0 | 0 |
| warm | system-surface | proxy | fresh-process-cli | 20 | 1119.3 | 1637.6 | 115.0 | 4609.0 | 0 |
| warm | xctest-stress | proxy | persistent-client | 20 | 612.4 | 1364.7 | 114.0 | 6842.0 | 0 |
| warm | xctest-stress | proxy | fresh-process-cli | 20 | 1135.6 | 2699.9 | 129.0 | 6842.0 | 0 |
| warm | quiet | proxy | persistent-client | 20 | 806.2 | 1109.4 | 55.0 | 1920.0 | 0 |
| warm | quiet | proxy | fresh-process-cli | 20 | 1801.3 | 3547.9 | 55.0 | 1919.0 | 0 |
| warm | list | proxy | persistent-client | 20 | 729.0 | 854.4 | 233.0 | 8282.0 | 0 |
| warm | list | proxy | fresh-process-cli | 20 | 1328.1 | 1976.2 | 232.0 | 8281.0 | 0 |
| warm | nested-scroll | proxy | persistent-client | 20 | 615.7 | 1301.8 | 109.0 | 6275.0 | 0 |
| warm | nested-scroll | proxy | fresh-process-cli | 20 | 1107.5 | 1921.8 | 105.0 | 6275.0 | 0 |
| warm | alert | proxy | persistent-client | 20 | 636.9 | 831.0 | 131.0 | 7168.0 | 0 |
| warm | alert | proxy | fresh-process-cli | 20 | 1362.4 | 1903.2 | 124.0 | 7167.0 | 0 |
| warm | system-surface | proxy | persistent-client | 20 | 637.9 | 1503.8 | 131.0 | 4610.0 | 0 |
| warm | system-surface | proxy | fresh-process-cli | 20 | 1145.3 | 1908.1 | 130.0 | 4610.0 | 0 |
| warm | xctest-stress | proxy | persistent-client | 20 | 618.8 | 924.8 | 130.0 | 6842.0 | 0 |
| warm | xctest-stress | proxy | fresh-process-cli | 20 | 1395.5 | 1638.5 | 130.0 | 6842.0 | 0 |

## Package size

Not measured.

## Deep-button control

- Fixture artifact: deep-button-fixture.v1.json (depth 72)
- Red control: pnpm bench:ios-snapshot:deep-button -- --rule invalid-shallow (exit 1)
  - AssertionError: changed descendant was omitted by shallow observation; no-effect claim is invalid.
- Safe control: pnpm bench:ios-snapshot:deep-button -- --rule safe-full (exit 0)
  - full observation changed and includes the changed descendant.
