# Code ownership

Before you edit a module with many callers, run `pnpm depgraph affected <path>` to identify callers and guarantees.

## Declarations

| Question | Owner |
| --- | --- |
| Command names | `packages/command-registry/src/catalog.ts` |
| Command descriptors | `packages/command-registry/src/`: `registry.ts`, `descriptor-*.ts`, `descriptors/` |
| Daemon request-policy predicates | `packages/daemon/src/core/daemon-command-registry.ts` |
| Interaction guarantees | `packages/contracts/src/interaction-guarantees.ts` |
| Runtime-fact admission | `packages/daemon/src/core/runtime-admission.ts`, `src/platform-runtime-gateway.ts` |
| Command facets and metadata, input schemas, CLI grammar, request projection, and the client port | `packages/command-surface/src/`, through its one entry |
| CLI output formatters, help, and progress | `src/commands/` |
| Input fields and audiences | `packages/command-surface/src/common-input-fields.ts`, `packages/command-surface/src/input-audience.ts` |
| Released SDK default hosts | `src/sdk/host.ts` |
| Apple runner host port and its one binding | `packages/apple-runner/src/host.ts`, `packages/platform-apple/src/core/runner-client.ts` |

For SDK entries `android-adb`, `artifacts`, `limrun`, `metro`, and `remote-config`, use `captureSdkHost` for defaults.
For command-host readers, use `withSdkHost`.
Keep provider callbacks on their supplied host.
Request cancellation and progress belong in `@agent-device/host-kit/request`.
Per-call abort guards belong beside transports in `src/daemon-client/daemon-client-transport.ts`.
Contracts shared across layers belong in `packages/contracts/src`.
Schema composition belongs in `packages/command-surface/src/schema`.
A command facet declares no output formatter. Register the formatter in `src/commands/cli-output.ts`.
Build interaction data through `buildInteractionResponseData`.
Change cross-language rules through `contracts/fixtures/` golden tables.

## Modules and tests

Name modules for the domain question they answer. Keep claims with the code that enforces them.
Use barrels only at package boundaries.
Before you add behavior, split files over 1,000 lines, except generated or fixture data.
Do not extend legacy interaction or platform index test aggregations.
Keep tests beside their named module. Put repository artifact guards in `test/repo-guards/`.
Shared test support belongs in `@agent-device/test-kit`, a devDependency.

## Diagnostics

Use `@agent-device/host-kit/diagnostics`. Keep request diagnostics in the session request log.
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
