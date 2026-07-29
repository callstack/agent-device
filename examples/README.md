# Examples

Runnable, typechecked Node.js examples for the `agent-device` SDK surface exposed to Node
consumers. Source of truth for the API itself is
[Typed Client](../website/docs/docs/client-api.md). Two guards keep these files in sync with that
doc: `src/__tests__/client-api-examples-drift.test.ts` checks the doc's subpath API manifest against
what these examples import, and `test/integration/client-api-doc-snippets.test.ts` compiles every
fenced TypeScript code block in the doc itself against the real `agent-device/*` sources.

## sdk/

Standalone scripts under [`sdk/`](./sdk) exercise the published `agent-device` export map —
`agent-device`, `agent-device/metro`, `agent-device/contracts`, and `agent-device/batch` — the same
way a Node consumer or the agent-device-cloud bridge would. Each file:

- has a top comment stating what it demonstrates and its prerequisites (daemon running,
  device/simulator available);
- typechecks without live hardware — `pnpm typecheck` resolves the `agent-device/...` imports
  against `src/sdk/` via [`examples/sdk/tsconfig.json`](./sdk/tsconfig.json)'s `paths`, so CI checks
  them without a build or publish step;
- imports the package by name (`agent-device/...`), not a relative `src/` path, so it exercises the
  same surface a real consumer sees;
- is runnable on its own with `node --experimental-strip-types` (repo Node is >=22.12) once the
  package is built (`pnpm build`) — running for real resolves `agent-device` as a self-referencing
  package, the same way an installed consumer would.

| Example | Subpath | Demonstrates |
| --- | --- | --- |
| [`client-session.ts`](./sdk/client-session.ts) | `agent-device` | `createAgentDeviceClient` → open → snapshot/tap → close, with typed error handling |
| [`metro-runtime.ts`](./sdk/metro-runtime.ts) | `agent-device/metro` | `normalizeBaseUrl`, `resolveRuntimeTransport` |
| [`contracts-result.ts`](./sdk/contracts-result.ts) | `agent-device/contracts` | typed result consumption via `centerOfRect` |
| [`batch-orchestration.ts`](./sdk/batch-orchestration.ts) | `agent-device/batch` | `runBatch` for a custom transport |

## test-app/

[`test-app/`](./test-app) is the Expo dogfood fixture used for `agent-device` experiments (see
its own [README](./test-app/README.md)) — it is a test fixture, not an SDK usage example.
