/**
 * The Vitest projects that `pnpm test:unit` runs in full. package.json spells the same list as
 * `--project` flags; scripts/lib/vitest-projects.test.ts fails when the two differ. This module
 * stays dependency-free: importing vitest.config.ts consumes its validation-report variable.
 */
export const UNIT_TEST_PROJECTS = ['unit-core', 'fuzz-worker'] as const;
