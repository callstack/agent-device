# iOS snapshot convergence benchmark

- Status: **completed**
- Revision: 71fb2483f30d90e615e949601c836aeebbf450c5
- Host: MacBook Pro (Mac16,8; Apple M4 Pro, 12 cores)
- Target: bench-golden-v2 (7E76ECA9-D40C-4833-A711-F870F8CE9363, com.apple.CoreSimulator.SimRuntime.iOS-27-0)
- Generated: 2026-09-01T17:02:50.284Z

| State | Screen | Transport | Execution | N | Wall median | Wall p95 | Daemon median | Response median | Failures |
|---|---|---|---|---:|---:|---:|---:|---:|---:|
| warm | quiet | local | fresh-process-cli | 20 | 153.5 | 315.3 | 50.0 | 4004.0 | 0 |
| warm | list | local | fresh-process-cli | 20 | 312.3 | 318.4 | 209.0 | 18020.0 | 0 |
| warm | nested-scroll | local | fresh-process-cli | 20 | 187.2 | 190.5 | 83.0 | 13537.0 | 0 |
| warm | alert | local | fresh-process-cli | 20 | 206.8 | 395.5 | 104.0 | 15668.0 | 0 |
| warm | system-surface | local | fresh-process-cli | 20 | 209.7 | 227.8 | 105.0 | 10012.0 | 0 |
| warm | xctest-stress | local | fresh-process-cli | 20 | 208.3 | 213.3 | 105.0 | 14944.0 | 0 |
| relaunch | quiet | local | fresh-process-cli | 20 | 3644.8 | 4251.3 | 627.0 | 5062.0 | 0 |
| relaunch | list | local | fresh-process-cli | 20 | 4377.9 | 5051.2 | 628.0 | 16422.0 | 0 |
| relaunch | nested-scroll | local | fresh-process-cli | 20 | 4313.5 | 4405.0 | 626.0 | 10562.0 | 0 |
| relaunch | alert | local | fresh-process-cli | 20 | 4369.5 | 5065.9 | 624.0 | 14233.0 | 0 |
| relaunch | system-surface | local | fresh-process-cli | 20 | 4916.8 | 5094.9 | 541.0 | 11207.0 | 0 |
| relaunch | xctest-stress | local | fresh-process-cli | 20 | 4260.1 | 5388.2 | 668.0 | 3506.0 | 0 |

## Package size

- Packed tarball: 982960 bytes
- Packed unpacked tree: 3347347 bytes
- Clean-installed package tree: 3347347 bytes (436 files)
- Bundled JavaScript: 2480947 raw / 835279 gzip bytes

## Deep-button control

- Fixture artifact: deep-button-fixture.v1.json (depth 72)
- Red control: pnpm bench:ios-snapshot:deep-button -- --rule invalid-shallow (exit 1)
  - AssertionError: changed descendant was omitted by shallow observation; no-effect claim is invalid.
- Safe control: pnpm bench:ios-snapshot:deep-button -- --rule safe-full (exit 0)
  - full observation changed and includes the changed descendant.
