import type { Reporter } from 'vitest/node';
import { defineConfig } from 'vitest/config';
import contentionRetryReporter, {
  FAILURE_FILE_ENV,
} from './scripts/lib/contention-retry-reporter.ts';
import { SUBPROCESS_STUB_TESTS } from './scripts/lib/contention-retry.ts';
import slowTestGateReporter from './scripts/vitest-slow-test-reporter.ts';

// Tests that stub a real binary (adb/xcrun/npx) by mutating process.env.PATH and
// then spawn it, so each case waits real subprocess/retry/poll time. Run at the
// unit suite's default ~7x file parallelism they contend for CPU and their stub
// spawns get starved past an internal budget, so production takes a generic
// failure path and returns a different error than the assertion expects — a
// contention flake whose failing subset shifts between runs (see
// docs/agents/testing.md "tests must not wait real time"). Serialized below with
// per-file isolation so only one such file spawns stubs at a time, the same
// execution contract the pre-split android index.test.ts aggregation provided.
// The enumerated file list, with each file's contention reason and its owned
// waiver, lives in scripts/lib/contention-retry.ts — the same constant the CI
// single-retry policy (#1419) reads, so the two cannot drift.
export { SUBPROCESS_STUB_TESTS };

/** Every project loads the same setup, including the runner-timeout provenance hook. */
const SETUP_FILES = [
  'scripts/vitest-runner-timeout-setup.ts',
  'src/__tests__/hermetic-env-setup.ts',
  'src/__tests__/process-memo-setup.ts',
];

/** Reporters for every lane; a `--reporter` flag would replace them, so no lane passes one. */
export function reporters(env: NodeJS.ProcessEnv = process.env): Array<string | Reporter> {
  const gates: Array<string | Reporter> = ['default', slowTestGateReporter()];
  // The failure sink drains the gates' verdicts, so it reports after them.
  return env[FAILURE_FILE_ENV] ? [...gates, contentionRetryReporter()] : gates;
}

export default defineConfig({
  test: {
    // Redirects TMPDIR to one per-run directory for the whole invocation (all
    // projects, every worker) and removes it once at the end — see the file
    // for why a single global hook beats per-file cleanup here.
    globalSetup: ['scripts/vitest-tmpdir-global-setup.ts'],
    // Wall-clock discipline: unit tests must not wait real time. Measured
    // 2026-07-04: the suite's duration was bounded by files sleeping through
    // production timeout budgets. slowTestThreshold surfaces creep in local
    // output; the slow-test reporter enforces the ratchet (pinned offenders
    // only shrink). Isolation stays ON and pool stays forks: measured
    // --no-isolate = 205s wall vs 48s (module state thrashes across files),
    // threads = no change.
    slowTestThreshold: 500,
    reporters: reporters(),
    projects: [
      {
        test: {
          name: 'unit-core',
          // Explicit script entries keep maintained conformance guards in the
          // unit suite without waking every ad-hoc *.test.ts under scripts/.
          include: [
            'src/**/*.test.ts',
            'packages/*/src/**/*.test.ts',
            'scripts/__tests__/help-conformance-bench.test.ts',
            'scripts/__tests__/help-conformance-error-recovery-coverage.test.ts',
            'scripts/__tests__/help-conformance-sample-outputs.test.ts',
            'scripts/__tests__/help-conformance-topic-coverage.test.ts',
            // The publishing gate's closure audit against fixture packages: parse-only, and the
            // only place the gate's failure direction is exercised at all (the gate itself needs a
            // real `npm pack`, so CI can only watch a healthy package pass).
            'scripts/__tests__/package-closure-audit.test.ts',
            // Parses CI configuration only, so this action guard needs no device or subprocess lane.
            'test/ci/upload-agent-device-artifacts.test.ts',
            // The frozen replay-compat corpus (#1417): parse-only, no device or
            // subprocess work, so it belongs in the fast lane next to the
            // grammar it guards.
            'test/replay-compat/corpus.test.ts',
            // The Maestro conformance oracle runs via `node --test` in its own CI
            // job (scripts/maestro-conformance), like the layering guard.
          ],
          exclude: [...SUBPROCESS_STUB_TESTS],
          setupFiles: SETUP_FILES,
        },
      },
      {
        // The subprocess-stub tests stub adb/xcrun/npx by mutating process.env
        // (PATH, AGENT_DEVICE_TEST_ARGS_FILE) and wait real subprocess/retry/poll
        // time, so the group runs serialized with per-file isolation — the same
        // execution contract the pre-split android index.test.ts aggregation
        // provided without leaking module caches between split files.
        test: {
          name: 'subprocess-stub',
          include: [...SUBPROCESS_STUB_TESTS],
          setupFiles: SETUP_FILES,
          fileParallelism: false,
          isolate: true,
          maxWorkers: 1,
        },
      },
      {
        test: {
          name: 'provider-integration',
          include: ['test/integration/provider-scenarios/**/*.test.ts'],
          setupFiles: SETUP_FILES,
        },
      },
      {
        test: {
          name: 'interaction-contract',
          include: ['test/integration/interaction-contract/**/*.test.ts'],
          setupFiles: SETUP_FILES,
        },
      },
      {
        test: {
          name: 'output-economy',
          include: ['test/output-economy/**/*.test.ts'],
          setupFiles: SETUP_FILES,
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
      include: ['src/**/*.ts', 'packages/*/src/**/*.ts'],
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
