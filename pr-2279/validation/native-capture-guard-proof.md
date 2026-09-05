# Native capture guard regression proof

Test commit: `5f7162931f38ce2f127e9cf42b8b7e29d92f29b1`, based on `944edfca3851f570a4b65df2d5ad0610fc542297`.

Command for each run:

```
pnpm exec vitest run packages/platform-apple/src/snapshot-source/native-runtime.test.ts
```

The fixture compiles the actual `SnapshotBridgeRuntime.m`. Only dynamic loading and native dependencies are mocked; `initWithError`, `snapshotForProcess`, both ownership guards, failure construction calls, and tree serialization execute. Automation setup is overridden to avoid modifying host settings.

1. Original production runtime: 5 tests passed.
2. Delete only the pre-acquisition `foreground-owner-unverified` block: 3 failed / 2 passed. Covered, missing, and malformed ownership fail with `refusal must name the ownership phase`.
3. Restore pre-acquisition guard; delete only the post-acquisition `foreground-owner-changed` block: 1 failed / 4 passed. Changed ownership fails with `refused capture must not publish the app tree`.
4. Restore both guards; synchronize dependencies with `pnpm install --frozen-lockfile` and rebuild with `pnpm build`: 5 passed, test file 3.04 seconds / Vitest total 4.27 seconds.

Each refusal requires a nil result, typed `unsupported` error with the exact ownership-phase code, preserved request ID, and the expected native acquisition count. The stable case requires successful materialization of the fixture app tree. The production runtime is unchanged in the committed test delta.

Compiler subprocess budget: 45 seconds. Setup-hook budget: 60 seconds. Each fixture process: 5 seconds. Exact-head full gate and iOS CI are separate obligations; these focused results do not claim either.
