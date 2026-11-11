import type { CoverageConfig } from '../coverage-crap/stamp.ts';

/**
 * The stamp's include/exclude for these suites, mirroring the `test.coverage`
 * include/exclude in `vitest.config.ts` for the paths the tests exercise:
 * both coverage roots, test files out, `src/sdk/**` out. One copy, shared by
 * the model and run suites, so a config change cannot leave them disagreeing.
 */
export const COVERAGE_CONFIG: CoverageConfig = {
  include: ['src/**/*.ts', 'packages/*/src/**/*.ts'],
  exclude: [
    '**/*.test.ts',
    '**/__tests__/**',
    '**/*-types.ts',
    '**/types.ts',
    'src/sdk/**',
    'src/bin.ts',
  ],
};
