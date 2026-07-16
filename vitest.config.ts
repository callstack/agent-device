import { defineConfig } from 'vitest/config';
import slowTestGateReporter from './scripts/vitest-slow-test-reporter.ts';

const ANDROID_ADB_STUB_TESTS =
  'src/platforms/android/__tests__/{app-lifecycle-install,app-lifecycle-open,device-input-state,input-actions,notifications,settings}.test.ts';

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
          name: 'unit-core',
          // Explicit script entries keep maintained conformance guards in the
          // unit suite without waking every ad-hoc *.test.ts under scripts/.
          include: [
            'src/**/*.test.ts',
            'scripts/__tests__/help-conformance-bench.test.ts',
            // The Maestro conformance oracle runs via `node --test` in its own CI
            // job (scripts/maestro-conformance), like the layering guard.
          ],
          exclude: [ANDROID_ADB_STUB_TESTS],
          setupFiles: ['src/__tests__/process-memo-setup.ts'],
        },
      },
      {
        // The scripted-adb tests stub the adb binary by mutating process.env
        // (PATH, AGENT_DEVICE_TEST_ARGS_FILE) and wait real retry/poll time,
        // so the group runs serialized with per-file isolation — the same
        // execution contract the pre-split android index.test.ts aggregation
        // provided without leaking module caches between split files.
        test: {
          name: 'android-adb',
          include: [ANDROID_ADB_STUB_TESTS],
          setupFiles: ['src/__tests__/process-memo-setup.ts'],
          fileParallelism: false,
          isolate: true,
          maxWorkers: 1,
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
      {
        test: {
          name: 'output-economy',
          include: ['test/output-economy/**/*.test.ts'],
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
