# iOS snapshot convergence benchmark

- Status: **completed**
- Revision: 7c434b575837e3291c51315bf9bb8b54c8ce7568
- Host: MacBook Pro (Mac16,8; Apple M4 Pro, 12 cores)
- Target: bench-2188-final (5FEADD02-98E4-4F01-861C-07003C1A3291, com.apple.CoreSimulator.SimRuntime.iOS-26-2)
- Generated: 2026-09-21T20:51:31.618Z

| State | Screen | Transport | Execution | N | Wall median | Wall p95 | Daemon median | Response median | Failures |
|---|---|---|---|---:|---:|---:|---:|---:|---:|
| cold-cold | quiet | local | fresh-process-cli | 10 | 7159.1 | 9060.7 | 5709.0 | 4365.0 | 0 |
| cold-cold | list | local | fresh-process-cli | 10 | 7580.2 | 9145.6 | 5881.0 | 18206.0 | 0 |
| cold-cold | nested-scroll | local | fresh-process-cli | 10 | 8091.3 | 9339.9 | 6374.0 | 13423.0 | 0 |
| cold-cold | alert | local | fresh-process-cli | 10 | 7460.8 | 10034.7 | 5689.0 | 16035.0 | 0 |
| cold-cold | system-surface | local | fresh-process-cli | 10 | 6553.0 | 9585.4 | 4961.0 | 11342.0 | 0 |
| cold-cold | xctest-stress | local | fresh-process-cli | 10 | 7273.4 | 9747.5 | 5761.0 | 16106.0 | 0 |
| cold | quiet | local | fresh-process-cli | 10 | 5743.0 | 6533.9 | 4409.0 | 4337.0 | 0 |
| cold | list | local | fresh-process-cli | 10 | 5847.5 | 6055.3 | 4420.0 | 17277.0 | 0 |
| cold | nested-scroll | local | fresh-process-cli | 10 | 6057.6 | 6525.3 | 4619.0 | 12214.0 | 0 |
| cold | alert | local | fresh-process-cli | 10 | 5706.1 | 5874.5 | 4310.0 | 15105.0 | 0 |
| cold | system-surface | local | fresh-process-cli | 10 | 5028.5 | 5436.4 | 3662.0 | 12586.0 | 0 |
| cold | xctest-stress | local | fresh-process-cli | 10 | 5679.0 | 5870.3 | 4323.0 | 14364.0 | 0 |

## Package size

Not measured.

## Deep-button control

- Fixture artifact: deep-button-fixture.v1.json (depth 72)
- Red control: pnpm bench:ios-snapshot:deep-button -- --rule invalid-shallow (exit 1)
  - AssertionError: changed descendant was omitted by shallow observation; no-effect claim is invalid.
- Safe control: pnpm bench:ios-snapshot:deep-button -- --rule safe-full (exit 0)
  - full observation changed and includes the changed descendant.
