# iOS snapshot convergence benchmark

- Status: **completed**
- Revision: 7c434b575837e3291c51315bf9bb8b54c8ce7568
- Host: MacBook Pro (Mac16,8; Apple M4 Pro, 12 cores)
- Target: bench-2188-final (5FEADD02-98E4-4F01-861C-07003C1A3291, com.apple.CoreSimulator.SimRuntime.iOS-26-2)
- Generated: 2026-09-21T19:20:51.180Z

| State | Screen | Transport | Execution | N | Wall median | Wall p95 | Daemon median | Response median | Failures |
|---|---|---|---|---:|---:|---:|---:|---:|---:|
| first-interaction | quiet | local | fresh-process-cli | 10 | 928.2 | 1189.3 | – | 567.0 | 0 |
| first-interaction | list | local | fresh-process-cli | 10 | 1435.7 | 1707.0 | – | 615.0 | 0 |
| first-interaction | nested-scroll | local | fresh-process-cli | 10 | 741.1 | 1241.7 | – | 579.0 | 0 |
| first-interaction | alert | local | fresh-process-cli | 10 | 1005.4 | 1018.1 | – | 546.0 | 0 |
| first-interaction | system-surface | local | fresh-process-cli | 10 | 1119.4 | 2051.8 | – | 548.0 | 0 |
| first-interaction | xctest-stress | local | fresh-process-cli | 10 | 1302.4 | 1341.0 | – | 539.0 | 0 |

## Package size

Not measured.

## Deep-button control

- Fixture artifact: deep-button-fixture.v1.json (depth 72)
- Red control: pnpm bench:ios-snapshot:deep-button -- --rule invalid-shallow (exit 1)
  - AssertionError: changed descendant was omitted by shallow observation; no-effect claim is invalid.
- Safe control: pnpm bench:ios-snapshot:deep-button -- --rule safe-full (exit 0)
  - full observation changed and includes the changed descendant.
