# iOS snapshot convergence benchmark

- Status: **completed**
- Revision: 7c434b575837e3291c51315bf9bb8b54c8ce7568
- Host: MacBook Pro (Mac16,8; Apple M4 Pro, 12 cores)
- Target: bench-2188-final (5FEADD02-98E4-4F01-861C-07003C1A3291, com.apple.CoreSimulator.SimRuntime.iOS-26-2)
- Generated: 2026-09-21T19:53:30.433Z

| State | Screen | Transport | Execution | N | Wall median | Wall p95 | Daemon median | Response median | Failures |
|---|---|---|---|---:|---:|---:|---:|---:|---:|
| warm | quiet | local | fresh-process-cli | 20 | 169.4 | 183.3 | 89.0 | 3448.0 | 0 |
| warm | list | local | fresh-process-cli | 20 | 291.2 | 309.3 | 202.0 | 18354.0 | 0 |
| warm | nested-scroll | local | fresh-process-cli | 20 | 249.8 | 268.2 | 167.0 | 12593.0 | 0 |
| warm | alert | local | fresh-process-cli | 20 | 224.0 | 238.6 | 139.0 | 16256.0 | 0 |
| warm | system-surface | local | fresh-process-cli | 20 | 207.7 | 225.2 | 130.0 | 11566.0 | 0 |
| warm | xctest-stress | local | fresh-process-cli | 20 | 213.1 | 233.1 | 128.0 | 14955.0 | 0 |
| relaunch | quiet | local | fresh-process-cli | 20 | 3876.5 | 3981.8 | 2851.0 | 2757.0 | 0 |
| relaunch | list | local | fresh-process-cli | 20 | 3888.4 | 3970.5 | 2871.0 | 2754.0 | 0 |
| relaunch | nested-scroll | local | fresh-process-cli | 20 | 3871.9 | 3958.4 | 2844.0 | 2800.0 | 0 |
| relaunch | alert | local | fresh-process-cli | 20 | 3896.4 | 4058.7 | 2881.0 | 2763.0 | 0 |
| relaunch | system-surface | local | fresh-process-cli | 20 | 3576.4 | 3640.7 | 2536.0 | 11302.0 | 0 |
| relaunch | xctest-stress | local | fresh-process-cli | 20 | 3867.8 | 4071.6 | 2855.0 | 2796.0 | 0 |

## Package size

- Packed tarball: 1409306 bytes
- Packed unpacked tree: 4723895 bytes
- Clean-installed package tree: 4723895 bytes (543 files)
- Bundled JavaScript: 3775024 raw / 1258950 gzip bytes

## Deep-button control

- Fixture artifact: deep-button-fixture.v1.json (depth 72)
- Red control: pnpm bench:ios-snapshot:deep-button -- --rule invalid-shallow (exit 1)
  - AssertionError: changed descendant was omitted by shallow observation; no-effect claim is invalid.
- Safe control: pnpm bench:ios-snapshot:deep-button -- --rule safe-full (exit 0)
  - full observation changed and includes the changed descendant.
