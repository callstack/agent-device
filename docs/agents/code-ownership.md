# Code ownership

Before you edit a widely used module, run `pnpm depgraph affected <path>`.

## Declarations

| Question | Owner |
| --- | --- |
| Command names | `packages/command-registry/src/catalog.ts` |
| Command descriptors | `packages/command-registry/src/`: `registry.ts`, `descriptor-*.ts`, `descriptors/` |
| Daemon request-policy predicates | `packages/daemon/src/core/daemon-command-registry.ts` |
| Interaction guarantees | `packages/contracts/src/interaction-guarantees.ts` |
| Runtime-fact admission | `packages/daemon/src/core/runtime-admission.ts`, `src/platform-runtime-gateway.ts` |
| Command facets, metadata, schemas, CLI grammar, projection, client port | `packages/command-surface/src/` |
| Output formatters | `packages/command-output/src/` |
| Help and progress | `src/commands/` |
| Input fields and audiences | `packages/command-surface/src/`: `common-input-fields.ts`, `input-audience.ts` |
| Released SDK default hosts | `src/sdk/host.ts` |
| Apple runner host port and binding | `packages/apple-runner/src/host.ts`, `packages/platform-apple/src/core/runner-client.ts` |

For SDK entries `android-adb`, `artifacts`, `limrun`, `metro`, and `remote-config`, use `captureSdkHost` for defaults.
For command-host readers, use `withSdkHost`.
Keep provider callbacks on their supplied host.
Request cancellation and progress belong in `@agent-device/host-kit/request`.
Per-call abort guards belong beside transports in `packages/daemon-client/src/daemon-client-transport.ts`.
Contracts shared across layers belong in `packages/contracts/src`.
Schema composition belongs in `packages/command-surface/src/schema`.
Command facets declare no formatter. Register formatters in `packages/command-output/src/cli-output.ts`.
Command execution and bound runtime families belong in `packages/command-runtime/src`.
Build interaction data through `buildInteractionResponseData`.
Change cross-language rules through `contracts/fixtures/` golden tables.

## Modules and tests

Name modules for the domain question they answer. Keep claims with the code that enforces them.
Use barrels only at package boundaries.
Do not extend legacy interaction or platform index test aggregations.
Keep tests beside their named module. Put repository artifact guards in `test/repo-guards/`.
Shared test support belongs in `@agent-device/test-kit`, a devDependency.

## CI toolchains

Select a preinstalled toolchain, such as Xcode, by the runner image in `runs-on`.
If no image provides it, add selection code. Record why.

## Diagnostics

Use `@agent-device/host-kit/diagnostics`. Keep request diagnostics in the session request log.
Keep app/device output in `app.log`, and Apple runner and xcodebuild output in `runner.log`.
Normalize errors with `normalizeError`. Preserve `hint`, `diagnosticId`, `logPath`, and typed `details`.

For interactions that take five seconds or more, examine daemon and runner recovery, retries, accessibility failures, and timeouts.

Use best-effort probes or caches only when the feature contract permits.
Keep their budgets below the required operation's.
