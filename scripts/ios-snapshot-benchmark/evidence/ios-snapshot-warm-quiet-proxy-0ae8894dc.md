# iOS snapshot convergence benchmark

- Status: **completed**
- Revision: 0ae8894dc5c6e5a63ad9a2499e7e10686f65edda
- Target: bench-golden-v1 (A149E1A0-1BBE-4F0E-B981-7E261206D043, com.apple.CoreSimulator.SimRuntime.iOS-27-0)
- Generated: 2026-09-01T10:40:57.793Z

| State | Screen | Transport | Execution | N | Wall median | Wall p95 | Daemon median | Response median | Failures |
|---|---|---|---|---:|---:|---:|---:|---:|---:|
| warm | quiet | proxy | persistent-client | 20 | 49.2 | 87.6 | 44.0 | 1920.0 | 0 |
| warm | quiet | proxy | fresh-process-cli | 20 | 148.8 | 174.1 | 45.0 | 1919.0 | 0 |

## Package size

Not measured.

## Deep-button control

- Fixture artifact: deep-button-fixture.v1.json (depth 72)
- Red control: pnpm bench:ios-snapshot:deep-button -- --rule invalid-shallow (exit 1)
  - AssertionError: changed descendant was omitted by shallow observation; no-effect claim is invalid.
- Safe control: pnpm bench:ios-snapshot:deep-button -- --rule safe-full (exit 0)
  - full observation changed and includes the changed descendant.
