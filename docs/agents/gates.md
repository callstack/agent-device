# Maintain gates

`CHECK_CATALOG` in `scripts/check-affected/checks.ts` owns checks and commands.
CI declares ownership through the shared `run-gate` action with a literal gate id.
For a new check, update the catalog and executable model.
To verify ownership and reachability, run `pnpm check:gate-manifest`.

For parser and geometry changes, extend shared fast-check arbitraries and properties.
Use `PROPERTY_RUNS` budgets. Keep examples for past bugs or named decisions.
Parser fuzz targets are in `scripts/fuzz/targets.ts`. Generators include deliberately invalid outcomes.
Use the harness command to promote discoveries. Do not hand-copy unshrunk inputs.

Mutation declarations are in `scripts/mutation/modules.ts`, test ownership in `scripts/mutation/ownership.ts`.
`scripts/mutation/run.ts` uses `KERNEL_MODULES` weekly and `LANE_SOURCES` for PR canaries.
Dispatch with `--with-dependencies` adds `LANE_DEPENDENCIES`.
Scores are advisory. Incomplete sweeps fail.
Before a pilot, read `pnpm mutation:run --help`.
Run `pnpm test:concurrency-torture`; it uses production lock decisions.
To replay, use the printed `TORTURE_SEED`.

Do not commit output stamped with a run or commit under `scripts/`.
Generate it or fetch evidence artifacts.
Versioned corpora, schemas, fixtures, and golden tables stay source inputs.
If TypeScript helpers cannot load, plain `.mjs` packaging fixtures keep child-process use local.
Prefer `execFile`.

## Before you add a startup-path import or change the wire

Read [ADR 0027](../adr/0027-descriptor-root-vs-eager-closure-budget.md).
Stage new entry files; entry discovery skips untracked files.
With the import present and `origin/main` fetched, run `pnpm exec vitest run --project unit-core scripts/__tests__/eager-closure-budgets.test.ts`.
For a wire change, read [the wire ledger](../../test/wire-compat/README.md) and run `pnpm exec vitest run --project unit-core test/wire-compat` for ledger, source, and protocol-version consistency.
With full history and release tags, run `pnpm check:daemon-wire-compat`.
A compatible digest change to a released declaration needs a `compatibleChanges` entry with the new digest.
A new declaration needs none. A break needs a protocol version bump.
