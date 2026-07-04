import { defineConfig } from 'vitest/config';
import slowTestGateReporter from './scripts/vitest-slow-test-reporter.ts';

export default defineConfig({
  test: {
    // Wall-clock discipline: unit tests must not wait real time. Measured
    // 2026-07-04: the suite's duration was bounded by files sleeping through
    // production timeout budgets. slowTestThreshold surfaces creep in local
    // output; the slow-test reporter enforces the ratchet (pinned offenders
    // only shrink). Isolation stays ON and pool stays forks: measured
    // --no-isolate = 205s wall vs 48s (module state thrashes across files),
    // threads = no change.
    slowTestThreshold: 500,
    reporters: ['default', slowTestGateReporter()],
    projects: [
      {
        test: {
          name: 'unit',
          include: ['src/**/*.test.ts'],
          setupFiles: ['src/__tests__/process-memo-setup.ts'],
        },
      },
      {
        test: {
          name: 'provider-integration',
          include: ['test/integration/provider-scenarios/**/*.test.ts'],
          setupFiles: ['src/__tests__/process-memo-setup.ts'],
        },
      },
      {
        test: {
          name: 'interaction-contract',
          include: ['test/integration/interaction-contract/**/*.test.ts'],
          setupFiles: ['src/__tests__/process-memo-setup.ts'],
        },
      },
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov', 'json-summary'],
      thresholds: {
        statements: 78,
        lines: 80,
      },
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/*.test.ts',
        'src/**/__tests__/**',
        'src/**/*-types.ts',
        'src/**/types.ts',
        'src/sdk/**',
        'src/bin.ts',
        'src/client/client-types.ts',
        'src/core/interactor-types.ts',
        'src/remote/remote-config.ts',
      ],
    },
  },
});
