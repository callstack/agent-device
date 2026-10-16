# Code ownership

Read this for shared contracts, package boundaries, request routing, or diagnostics.
Before editing a high-fan-in module, run `pnpm depgraph affected <path>` to scope callers and guarantees.

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

Shared selectors belong in `@agent-device/selectors`. Request cancellation and progress belong in
`@agent-device/host-kit/request`. Per-call abort guards belong beside transports in
`src/daemon-client/daemon-client-transport.ts`. Cross-layer contracts belong in `packages/contracts/src`.
CLI flags belong in `src/commands/cli-grammar`; schema composition belongs in `src/commands/schema`.
Build interaction data through `buildInteractionResponseData`. Change cross-language rules through `contracts/fixtures/` golden tables.

## Modules and tests

Name modules for the domain question they answer. Colocate claims with their enforcement.
Use barrels only at package boundaries. Split files over 1,000 lines before adding behavior, except generated or fixture data.
Split a source module and its tests together. Do not extend legacy interaction or platform index test aggregations.
Keep tests beside their named module. Put repository artifact guards in `test/repo-guards/`.
Shared helpers belong in `@agent-device/test-kit`, a devDependency.
Production code never imports test-kit. Test-kit never depends on platforms, providers, the daemon, or root.
Do not export test support from production packages.

## Diagnostics

Use `@agent-device/host-kit/diagnostics`. Keep request diagnostics in the session request log.
Get session artifact paths from `packages/daemon-contracts/src/session-artifact-paths.ts`.
Keep app/device output in `app.log`; keep Apple runner and xcodebuild output in `runner.log`.
Normalize errors with `normalizeError`. Preserve `hint`, `diagnosticId`, `logPath`, and typed `details`.
For interactions taking at least five seconds, inspect daemon and runner recovery, retries, accessibility failures, and timeouts.
Use best-effort probes or caches only when the feature contract permits them. Keep their budgets below the required operation's budget.
