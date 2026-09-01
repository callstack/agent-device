# iOS snapshot convergence benchmark

- Status: **completed**
- Revision: 955ed760e4563f181db91ffe719ba74e827e21bf
- Host: MacBook Pro (Mac16,8; Apple M4 Pro, 12 cores)
- Target: bench-golden-v2 (7E76ECA9-D40C-4833-A711-F870F8CE9363, com.apple.CoreSimulator.SimRuntime.iOS-27-0)
- Generated: 2026-09-01T14:47:44.319Z

| State | Screen | Transport | Execution | N | Wall median | Wall p95 | Daemon median | Response median | Failures |
|---|---|---|---|---:|---:|---:|---:|---:|---:|
| warm | quiet | proxy | persistent-client | 20 | 51.0 | 76.2 | 46.0 | 1919.0 | 0 |
| warm | quiet | proxy | fresh-process-cli | 20 | 387.5 | 653.8 | 103.0 | 1922.0 | 0 |
| warm | list | proxy | persistent-client | 20 | 214.1 | 247.4 | 208.0 | 8281.0 | 0 |
| warm | list | proxy | fresh-process-cli | 20 | 322.6 | 339.2 | 210.0 | 8281.0 | 0 |
| warm | nested-scroll | proxy | persistent-client | 20 | 85.6 | 104.7 | 79.0 | 6273.0 | 0 |
| warm | nested-scroll | proxy | fresh-process-cli | 20 | 185.5 | 197.9 | 83.0 | 6272.0 | 0 |
| warm | alert | proxy | persistent-client | 20 | 108.2 | 110.4 | 102.0 | 7166.0 | 0 |
| warm | alert | proxy | fresh-process-cli | 20 | 213.1 | 218.1 | 107.0 | 7167.0 | 0 |
| warm | system-surface | proxy | persistent-client | 20 | 111.9 | 131.2 | 105.0 | 4609.0 | 0 |
| warm | system-surface | proxy | fresh-process-cli | 20 | 207.5 | 217.1 | 106.0 | 4609.0 | 0 |
| warm | xctest-stress | proxy | persistent-client | 20 | 108.3 | 130.1 | 103.0 | 6841.0 | 0 |
| warm | xctest-stress | proxy | fresh-process-cli | 20 | 209.5 | 232.6 | 106.0 | 6842.0 | 0 |
| warm | quiet | proxy | persistent-client | 20 | 556.8 | 864.8 | 70.0 | 1918.0 | 0 |
| warm | quiet | proxy | fresh-process-cli | 20 | 1077.4 | 1485.8 | 74.0 | 1918.0 | 0 |
| warm | list | proxy | persistent-client | 20 | 662.7 | 714.6 | 215.0 | 8281.0 | 0 |
| warm | list | proxy | fresh-process-cli | 20 | 1239.6 | 1998.2 | 234.0 | 8281.0 | 0 |
| warm | nested-scroll | proxy | persistent-client | 20 | 501.0 | 1011.1 | 107.0 | 6274.0 | 0 |
| warm | nested-scroll | proxy | fresh-process-cli | 20 | 1114.6 | 1462.2 | 108.0 | 6275.0 | 0 |
| warm | alert | proxy | persistent-client | 20 | 636.5 | 846.7 | 132.0 | 7167.0 | 0 |
| warm | alert | proxy | fresh-process-cli | 20 | 1133.0 | 1775.6 | 112.0 | 7167.0 | 0 |
| warm | system-surface | proxy | persistent-client | 20 | 613.6 | 1221.9 | 111.0 | 4610.0 | 0 |
| warm | system-surface | proxy | fresh-process-cli | 20 | 1110.8 | 1997.4 | 111.0 | 4610.0 | 0 |
| warm | xctest-stress | proxy | persistent-client | 20 | 602.5 | 1439.7 | 114.0 | 6842.0 | 0 |
| warm | xctest-stress | proxy | fresh-process-cli | 20 | 1133.2 | 2443.4 | 119.0 | 6841.0 | 0 |
| warm | quiet | proxy | persistent-client | 20 | 998.5 | 1019.3 | 60.0 | 1919.0 | 0 |
| warm | quiet | proxy | fresh-process-cli | 20 | 1873.1 | 2025.2 | 73.0 | 1919.0 | 0 |
| warm | list | proxy | persistent-client | 20 | 736.6 | 937.8 | 232.0 | 8281.0 | 0 |
| warm | list | proxy | fresh-process-cli | 20 | 1243.1 | 1775.5 | 232.0 | 8281.0 | 0 |
| warm | nested-scroll | proxy | persistent-client | 20 | 611.9 | 871.7 | 108.0 | 6274.0 | 0 |
| warm | nested-scroll | proxy | fresh-process-cli | 20 | 1119.9 | 2042.6 | 110.0 | 6275.0 | 0 |
| warm | alert | proxy | persistent-client | 20 | 636.5 | 1005.6 | 130.0 | 7167.0 | 0 |
| warm | alert | proxy | fresh-process-cli | 20 | 1144.3 | 2005.7 | 132.0 | 7167.0 | 0 |
| warm | system-surface | proxy | persistent-client | 20 | 618.7 | 1237.6 | 130.0 | 4610.0 | 0 |
| warm | system-surface | proxy | fresh-process-cli | 20 | 1501.5 | 2481.8 | 128.0 | 4609.0 | 0 |
| warm | xctest-stress | proxy | persistent-client | 20 | 634.0 | 747.1 | 130.0 | 6841.0 | 0 |
| warm | xctest-stress | proxy | fresh-process-cli | 20 | 1222.2 | 2071.8 | 130.0 | 6842.0 | 0 |

## Package size

Not measured.

## Deep-button control

- Fixture artifact: deep-button-fixture.v1.json (depth 72)
- Red control: pnpm bench:ios-snapshot:deep-button -- --rule invalid-shallow (exit 1)
  - AssertionError: changed descendant was omitted by shallow observation; no-effect claim is invalid.
- Safe control: pnpm bench:ios-snapshot:deep-button -- --rule safe-full (exit 0)
  - full observation changed and includes the changed descendant.
