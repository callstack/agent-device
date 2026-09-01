# iOS snapshot convergence benchmark

- Status: **completed**
- Revision: 955ed760e4563f181db91ffe719ba74e827e21bf
- Target: bench-golden-v2 (7E76ECA9-D40C-4833-A711-F870F8CE9363, com.apple.CoreSimulator.SimRuntime.iOS-27-0)
- Generated: 2026-09-01T13:48:38.160Z

| State | Screen | Transport | Execution | N | Wall median | Wall p95 | Daemon median | Response median | Failures |
|---|---|---|---|---:|---:|---:|---:|---:|---:|
| warm | quiet | local | fresh-process-cli | 20 | 146.6 | 153.8 | 49.0 | 4002.0 | 0 |
| warm | list | local | fresh-process-cli | 20 | 320.6 | 336.0 | 215.0 | 18021.0 | 0 |
| warm | nested-scroll | local | fresh-process-cli | 20 | 188.6 | 193.7 | 84.0 | 13537.0 | 0 |
| warm | alert | local | fresh-process-cli | 20 | 213.5 | 218.4 | 108.0 | 15669.0 | 0 |
| warm | system-surface | local | fresh-process-cli | 20 | 212.0 | 221.1 | 107.0 | 10012.0 | 0 |
| warm | xctest-stress | local | fresh-process-cli | 20 | 209.0 | 218.3 | 106.0 | 14943.0 | 0 |
| relaunch | quiet | local | fresh-process-cli | 20 | 3665.3 | 3755.0 | 628.0 | 5062.0 | 0 |
| relaunch | list | local | fresh-process-cli | 20 | 4354.3 | 4446.9 | 631.0 | 16422.0 | 0 |
| relaunch | nested-scroll | local | fresh-process-cli | 20 | 4293.3 | 4335.5 | 632.0 | 10563.0 | 0 |
| relaunch | alert | local | fresh-process-cli | 20 | 4365.7 | 4387.4 | 625.0 | 14234.0 | 0 |
| relaunch | system-surface | local | fresh-process-cli | 20 | 4897.9 | 5042.6 | 546.0 | 11207.0 | 0 |
| relaunch | xctest-stress | local | fresh-process-cli | 20 | 4449.1 | 4509.6 | 629.0 | 13751.0 | 0 |

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
