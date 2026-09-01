# iOS snapshot convergence benchmark

- Status: **completed**
- Revision: e9b1fc523278645a0d96e696db02779566bc57f2
- Target: bench-golden-v1 (A149E1A0-1BBE-4F0E-B981-7E261206D043, com.apple.CoreSimulator.SimRuntime.iOS-27-0)
- Generated: 2026-09-01T09:43:55.880Z

| State | Screen | Transport | Execution | N | Wall median | Wall p95 | Daemon median | Response median | Failures |
|---|---|---|---|---:|---:|---:|---:|---:|---:|
| warm | quiet | proxy | persistent-client | 20 | 48.9 | 70.6 | 45.0 | 1920.0 | 0 |
| warm | quiet | proxy | fresh-process-cli | 20 | 143.9 | 183.2 | 49.0 | 1920.0 | 0 |

## Package size

Not measured.

## Deep-button control

- Fixture artifact: deep-button-fixture.v1.json (depth 72)
- Red control: pnpm bench:ios-snapshot:deep-button -- --rule invalid-shallow (exit 1)
  - AssertionError: changed descendant was omitted by shallow observation; no-effect claim is invalid.
- Safe control: pnpm bench:ios-snapshot:deep-button -- --rule safe-full (exit 0)
  - full observation changed and includes the changed descendant.
