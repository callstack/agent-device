# iOS snapshot convergence benchmark

- Status: **completed**
- Revision: 71fb2483f30d90e615e949601c836aeebbf450c5
- Host: MacBook Pro (Mac16,8; Apple M4 Pro, 12 cores)
- Target: bench-golden-v2 (7E76ECA9-D40C-4833-A711-F870F8CE9363, com.apple.CoreSimulator.SimRuntime.iOS-27-0)
- Generated: 2026-09-01T16:22:03.256Z

| State | Screen | Transport | Execution | N | Wall median | Wall p95 | Daemon median | Response median | Failures |
|---|---|---|---|---:|---:|---:|---:|---:|---:|
| cold-cold | quiet | local | fresh-process-cli | 10 | 17543.5 | 22929.8 | 15161.0 | 4799.0 | 0 |
| cold-cold | list | local | fresh-process-cli | 10 | 19170.3 | 24483.4 | 17191.0 | 16905.0 | 0 |
| cold-cold | nested-scroll | local | fresh-process-cli | 10 | 19406.5 | 23539.2 | 17773.0 | 13072.0 | 0 |
| cold-cold | alert | local | fresh-process-cli | 10 | 19448.1 | 22780.4 | 17436.0 | 14064.0 | 0 |
| cold-cold | system-surface | local | fresh-process-cli | 10 | 20234.6 | 25803.2 | 17974.0 | 9889.0 | 0 |
| cold-cold | xctest-stress | local | fresh-process-cli | 10 | 20810.8 | 24972.4 | 18506.0 | 14278.0 | 0 |
| cold | quiet | local | fresh-process-cli | 10 | 6642.7 | 12049.3 | 5886.0 | 4773.0 | 0 |
| cold | list | local | fresh-process-cli | 10 | 6850.8 | 7275.3 | 5897.0 | 16879.0 | 0 |
| cold | nested-scroll | local | fresh-process-cli | 10 | 6713.5 | 7077.1 | 5884.0 | 13046.0 | 0 |
| cold | alert | local | fresh-process-cli | 10 | 6674.4 | 6974.5 | 5868.0 | 14038.0 | 0 |
| cold | system-surface | local | fresh-process-cli | 10 | 6819.1 | 8805.5 | 5957.0 | 9863.0 | 0 |
| cold | xctest-stress | local | fresh-process-cli | 10 | 6714.4 | 7044.2 | 5874.0 | 14252.0 | 0 |

## Package size

Not measured.

## Deep-button control

- Fixture artifact: deep-button-fixture.v1.json (depth 72)
- Red control: pnpm bench:ios-snapshot:deep-button -- --rule invalid-shallow (exit 1)
  - AssertionError: changed descendant was omitted by shallow observation; no-effect claim is invalid.
- Safe control: pnpm bench:ios-snapshot:deep-button -- --rule safe-full (exit 0)
  - full observation changed and includes the changed descendant.
