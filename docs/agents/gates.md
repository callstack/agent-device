# Maintain gates

For execution, read [validation](testing.md).

`CHECK_CATALOG` in `scripts/check-affected/checks.ts` owns checks and commands.
CI declares ownership through the shared `run-gate` action with a literal gate id.
For a new check, update the catalog and executable model.
To verify ownership and reachability, run `pnpm check:gate-manifest`.
Insert a violation to prove a new gate or selector detects it.
Use [isolated experiments](test-experiments.md).

For parser and geometry changes, extend shared fast-check arbitraries and properties.
Use `PROPERTY_RUNS` budgets. Keep examples for past bugs or named decisions.
Parser fuzz targets are in `scripts/fuzz/targets.ts`. Generators include deliberately invalid outcomes.
Use the harness command to promote discoveries. Do not manually copy inputs that the harness has not shrunk.

Mutation declarations are in `scripts/mutation/modules.ts`.
Test ownership is in `scripts/mutation/ownership.ts`.
`scripts/mutation/run.ts` uses `KERNEL_MODULES` weekly and `LANE_SOURCES` for PR canaries.
Dispatch with `--with-dependencies` adds `LANE_DEPENDENCIES`.
Scores are advisory. Incomplete sweeps fail.
Before a pilot, read `pnpm mutation:run --help`.
Concurrency torture uses production lock decisions.
Run `pnpm test:concurrency-torture`.
To replay, use the printed `TORTURE_SEED`.

Do not commit output stamped with a run or commit under `scripts/`.
Generate it or fetch evidence artifacts.
Versioned corpora, schemas, fixtures, and golden tables remain source inputs.
If TypeScript helpers cannot load, plain `.mjs` packaging fixtures keep child-process use local.
Prefer `execFile`.
