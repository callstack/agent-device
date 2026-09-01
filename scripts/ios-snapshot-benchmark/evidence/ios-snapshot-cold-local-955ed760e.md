# iOS snapshot convergence benchmark

- Status: **completed**
- Revision: 955ed760e4563f181db91ffe719ba74e827e21bf
- Target: bench-golden-v2 (7E76ECA9-D40C-4833-A711-F870F8CE9363, com.apple.CoreSimulator.SimRuntime.iOS-27-0)
- Generated: 2026-09-01T14:32:03.733Z

| State | Screen | Transport | Execution | N | Wall median | Wall p95 | Daemon median | Response median | Failures |
|---|---|---|---|---:|---:|---:|---:|---:|---:|
| cold-cold | quiet | local | fresh-process-cli | 10 | 18483.0 | 21128.7 | 16742.0 | 4798.0 | 0 |
| cold-cold | list | local | fresh-process-cli | 10 | 19580.3 | 21757.6 | 17752.0 | 16905.0 | 0 |
| cold-cold | nested-scroll | local | fresh-process-cli | 10 | 19290.6 | 20772.7 | 17701.0 | 13073.0 | 0 |
| cold-cold | alert | local | fresh-process-cli | 10 | 19240.6 | 25459.2 | 17690.0 | 14064.0 | 0 |
| cold-cold | system-surface | local | fresh-process-cli | 10 | 19852.8 | 25195.4 | 18023.0 | 9889.0 | 0 |
| cold-cold | xctest-stress | local | fresh-process-cli | 10 | 22707.0 | 25770.6 | 19763.0 | 14278.0 | 0 |
| cold | quiet | local | fresh-process-cli | 10 | 6978.2 | 14339.4 | 6168.0 | 4773.0 | 0 |
| cold | list | local | fresh-process-cli | 10 | 6981.7 | 8062.7 | 6021.0 | 16878.0 | 0 |
| cold | nested-scroll | local | fresh-process-cli | 10 | 7097.1 | 7940.6 | 6297.0 | 13046.0 | 0 |
| cold | alert | local | fresh-process-cli | 10 | 6698.5 | 7312.5 | 5890.0 | 14038.0 | 0 |
| cold | system-surface | local | fresh-process-cli | 10 | 6733.6 | 8900.0 | 5841.0 | 9863.0 | 0 |
| cold | xctest-stress | local | fresh-process-cli | 10 | 6652.2 | 6811.1 | 5829.0 | 14253.0 | 0 |

## Package size

Not measured.

## Deep-button control

- Fixture artifact: deep-button-fixture.v1.json (depth 72)
- Red control: pnpm bench:ios-snapshot:deep-button -- --rule invalid-shallow (exit 1)
  - AssertionError: changed descendant was omitted by shallow observation; no-effect claim is invalid.
- Safe control: pnpm bench:ios-snapshot:deep-button -- --rule safe-full (exit 0)
  - full observation changed and includes the changed descendant.
