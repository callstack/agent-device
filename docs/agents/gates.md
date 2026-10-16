# Maintain gates

For execution, read [validation](testing.md).

`CHECK_CATALOG` in `scripts/check-affected/checks.ts` owns checks and commands.
CI declares ownership through the shared `run-gate` action with a literal gate id.
Update the catalog and executable model for a new check. Run `pnpm check:gate-manifest` to verify ownership and reachability.
Plant a violation to prove a new gate or selector detects it. Use [isolated experiments](test-experiments.md).

For parser and geometry changes, extend shared fast-check arbitraries and properties.
Use `PROPERTY_RUNS` budgets. Keep examples for past bugs or named decisions.
Parser fuzz targets live in `scripts/fuzz/targets.ts`. Generators carry planted invalid outcomes.
Promote discoveries with the harness command; do not hand-copy unshrunk inputs.

Mutation declarations live in `scripts/mutation/modules.ts`; test ownership lives in `scripts/mutation/ownership.ts`.
`scripts/mutation/run.ts` uses `KERNEL_MODULES` weekly and `LANE_SOURCES` for PR canaries.
Dispatch with `--with-dependencies` adds `LANE_DEPENDENCIES`.
Scores are advisory; incomplete sweeps fail. Read `pnpm mutation:run --help` before a pilot.
Concurrency torture uses production lock decisions. Run `pnpm test:concurrency-torture`; replay with the printed `TORTURE_SEED`.

Do not commit run- or commit-stamped output under `scripts/`. Generate it or fetch evidence artifacts.
Versioned corpora, schemas, fixtures, and golden tables remain source inputs.
Plain `.mjs` packaging fixtures keep child-process use local when TypeScript helpers cannot load; prefer `execFile`.
