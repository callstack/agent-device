# Code ownership

Read this for shared contracts, package boundaries, request routing, or diagnostics.
Before you edit a module with many callers, run `pnpm depgraph affected <path>` to identify callers and guarantees.

## Declarations

Read the owner. Do not copy its policy into consumers.

| Question | Owner |
| --- | --- |
| Command names | `packages/command-registry/src/catalog.ts` |
| Surface, runtime, batch, timeout traits | `packages/command-registry/src/registry.ts` |
| Daemon routes and request policy | `packages/daemon/src/core/daemon-command-registry.ts` |
| Interaction guarantees | `packages/contracts/src/interaction-guarantees.ts` |
| Runtime-fact admission | `packages/daemon/src/core/runtime-admission.ts`, `src/platform-runtime-gateway.ts` |
| Input fields and audiences | `src/commands/common-input-fields.ts`, `src/commands/input-audience.ts` |

Shared selectors belong in `@agent-device/selectors`.
Request cancellation and progress belong in `@agent-device/host-kit/request`.
Per-call abort guards belong beside transports in `src/daemon-client/daemon-client-transport.ts`.
Contracts shared across layers belong in `packages/contracts/src`.
For CLI flag owners, see `cli-flags.md`.
Schema composition belongs in `src/commands/schema`.
Build interaction data through `buildInteractionResponseData`.
Change cross-language rules through `contracts/fixtures/` golden tables.

## Modules and tests

Name modules for the domain question they answer. Keep claims with the code that enforces them.
Use barrels only at package boundaries.
Before you add behavior, split files over 1,000 lines, except generated or fixture data.
Split a source module and its tests together.
Do not extend legacy interaction or platform index test aggregations.
Keep tests beside their named module. Put repository artifact guards in `test/repo-guards/`.
Shared helpers belong in `@agent-device/test-kit`, a devDependency.
Production code never imports test-kit.
Test-kit never depends on:

- Platforms.
- Providers.
- The daemon.
- Root.

Do not export test support from production packages.

## Diagnostics

Use `@agent-device/host-kit/diagnostics`. Keep request diagnostics in the session request log.
Get session artifact paths from `packages/daemon-contracts/src/session-artifact-paths.ts`.
Keep app/device output in `app.log`.
Keep Apple runner and xcodebuild output in `runner.log`.
Normalize errors with `normalizeError`. Preserve these fields:

- `hint`.
- `diagnosticId`.
- `logPath`.
- Typed `details`.

For interactions that take at least five seconds, examine:

- Daemon and runner recovery.
- Retries.
- Accessibility failures.
- Timeouts.

Only when the feature contract permits them, use best-effort probes or caches.
Keep their budgets below the required operation's budget.
