import { defineConfig } from 'vitest/config';
import { resolveVitestMaxWorkers } from './scripts/lib/vitest-concurrency.ts';
import slowTestGateReporter from './scripts/vitest-slow-test-reporter.ts';

// Files that spawn a real subprocess per case, so under broad file parallelism the
// spawns get starved past an internal budget and production returns a generic
// timeout instead of the asserted error. The subprocess-stub project below runs
// them one at a time to bound that contention; per-file `process.env` isolation is
// already delivered by `pool: forks` + `isolate: true` on every project.
// Membership and the project's deletion test live in issue #1823.
export const SUBPROCESS_STUB_TESTS: readonly string[] = [
  // Stubs npx plus the package managers and spawns a real Metro dev server per case.
  'src/__tests__/client-metro.test.ts',
  // The SUT is the subprocess watchdog: a node subprocess per case, one hangs on purpose (#1414).
  'scripts/fuzz/harness.test.ts',
  // Replays the fuzz corpus through that same worker watchdog, waiting its per-case budget.
  'scripts/fuzz/corpus-replay.test.ts',
];

// Imported by vitest.mutation.config.ts so the two lanes cannot drift: a guard
// added here must reach the Stryker sandbox too.
export const SETUP_FILES = [
  'src/__tests__/hermetic-env-setup.ts',
  'src/__tests__/hermetic-signal-setup.ts',
  'src/__tests__/process-memo-setup.ts',
];

// The CI Coverage lane shards the instrumented suite across runners and merges
// the results on one of them (see ci.yml). AGENT_DEVICE_COVERAGE_SHARD="<i>/<n>"
// turns an invocation into shard i of n writing a blob report; both unset means
// the ordinary full run. AGENT_DEVICE_COVERAGE_MERGE=1 aggregates previously
// written blobs instead of collecting tests — it still evaluates thresholds and
// writes every configured coverage report.
const COVERAGE_SHARD = process.env.AGENT_DEVICE_COVERAGE_SHARD;
const COVERAGE_MERGE = process.env.AGENT_DEVICE_COVERAGE_MERGE === '1';

export default defineConfig({
  test: {
    ...(COVERAGE_SHARD ? { shard: COVERAGE_SHARD } : {}),
    ...(COVERAGE_MERGE ? { mergeReports: '.vitest-reports' } : {}),
    outputFile: COVERAGE_SHARD
      ? { blob: `.vitest-reports/blob-${COVERAGE_SHARD.split('/')[0]}.json` }
      : undefined,
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
    // Vitest otherwise derives 11 workers from this 12-core host. Three
    // concurrent Codex worktrees can then request 33 workers and starve the
    // subprocess/test-server paths behind exact timeout budgets. Two workers
    // per local invocation preserves useful parallelism while leaving host
    // headroom. CI stays uncapped so Vitest derives the runner-appropriate
    // worker count from the isolated machine's available CPU pool.
    maxWorkers: resolveVitestMaxWorkers(),
    // hermetic-env-setup clears worker-scoped device claims after every case.
    // Capping explicit `test.concurrent` work at one enforces that teardown
    // assumption without reducing ordinary file-level parallelism.
    maxConcurrency: 1,
    // Gate reporters for every lane; a `--reporter` flag would replace them, so no lane passes one.
    // A coverage shard swaps in the blob reporter alongside the default one: its console output is
    // only per-shard noise anyway, and the merge run below needs the blobs to exist.
    reporters: COVERAGE_SHARD ? ['default', 'blob'] : ['default', slowTestGateReporter()],
    projects: [
      {
        test: {
          name: 'unit-core',
          // Explicit script entries keep maintained conformance guards in the
          // unit suite without waking every ad-hoc *.test.ts under scripts/.
          include: [
            'src/**/*.test.ts',
            'packages/*/src/**/*.test.ts',
            // The validation fuzz generators' expectation gates (#1781 B2): in-process, no
            // subprocess or worker, so they ride the fast lane unlike their serialized siblings.
            'scripts/fuzz/validation-arbitraries.test.ts',
            'scripts/fuzz/validation-arbitraries-cli.test.ts',
            'scripts/fuzz/validation-arbitraries-maestro.test.ts',
            'scripts/fuzz/validation-case.test.ts',
            'scripts/fuzz/envelope.test.ts',
            'scripts/__tests__/help-conformance-bench.test.ts',
            'scripts/__tests__/help-conformance-error-recovery-coverage.test.ts',
            'scripts/__tests__/help-conformance-expectation-falsification.test.ts',
            'scripts/__tests__/help-conformance-sample-outputs.test.ts',
            'scripts/__tests__/help-conformance-topic-coverage.test.ts',
            // Lives here rather than under src/ on purpose: it measures the repository's own
            // files and git history, which Stryker's sandbox copy cannot answer (the copies are
            // rewritten, and there is no origin/main). The mutation lane admits only root/package
            // `src` tests, so this address makes it unreachable there by construction instead of
            // by a classifier that has to recognise it — see KERNEL_TEST_FILE_RE in
            // scripts/mutation/modules.ts.
            'scripts/__tests__/test-file-size-ratchet.test.ts',
            'scripts/__tests__/agent-setup-startup-contract.test.ts',
            'scripts/__tests__/npm-skills-exclusion.test.ts',
            'scripts/__tests__/simulator-skills-contract.test.ts',
            // Parses ios.yml and the runner's Swift sources: no Xcode, no simulator, and
            // the check it guards is what keeps the PR lane's `-only-testing:` list honest.
            'scripts/__tests__/xctest-selection.test.ts',
            // The nightly XCTest lane's reporter/liveness check, which otherwise only ever
            // executes on a macOS runner at 04:30.
            'scripts/__tests__/xctest-run-summary.test.ts',
            // The Fallow fixture policy is executable configuration: unused exports are exempt,
            // but fixture modules remain visible to the other analysis families.
            'scripts/__tests__/fallow-fixture-policy.test.ts',
            // The publishing gate's closure audit against fixture packages: parse-only, and the
            // only place the gate's failure direction is exercised at all (the gate itself needs a
            // real `npm pack`, so CI can only watch a healthy package pass).
            'scripts/__tests__/package-closure-audit.test.ts',
            // The Bundle Size lane's PR-comment path: spawns the real script against a
            // stubbed fetch, so it needs no network; pins retry/reconcile/fatal outcomes.
            'scripts/__tests__/size-report-post-comment.test.ts',
            // Package attribution is a pure npm-pack manifest model. Keep it in the fast lane so
            // every new package path remains accounted for without building an archive.
            'scripts/__tests__/size-report-package.test.ts',
            // Parses CI configuration only, so this action guard needs no device or subprocess lane.
            'test/ci/upload-agent-device-artifacts.test.ts',
            // The size reporter is preserved across a base checkout; its entrypoint and imported
            // modules must move as one directory or the Bundle Size lane fails before measuring.
            'test/ci/size-workflow.test.ts',
            // #1781 A9: pins the root-doc paths-ignore entries directly against the
            // real workflow YAML, parse-only like its sibling above.
            'test/ci/root-docs-paths-ignore.test.ts',
            // The daemon leak oracle's lifecycle/residue rules (#1781 B1): pure
            // decisions over fixture state-dir listings, so they need no daemon,
            // device, or subprocess.
            'test/integration/support/daemon-leak-model.test.ts',
            // The frozen replay-compat corpus (#1417): parse-only, no device or
            // subprocess work, so it belongs in the fast lane next to the
            // grammar it guards.
            'test/replay-compat/corpus.test.ts',
            // The daemon RPC wire ledger (#1432): parses source and hashes
            // declarations, so it needs no history, network, or device — the
            // released-tag half runs in its own full-history job.
            'test/wire-compat/wire-compat.test.ts',
            'test/wire-compat/wire-mutations.test.ts',
            // The Maestro conformance oracle runs via `node --test` in its own CI
            // job (scripts/maestro-conformance), like the layering guard.
          ],
          exclude: [...SUBPROCESS_STUB_TESTS],
          setupFiles: SETUP_FILES,
        },
      },
      {
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
      // A shard sees roughly half the suite, so its own numbers sit far below
      // the gate; thresholds are enforced once on the merged full-suite run.
      thresholds: COVERAGE_SHARD ? { statements: 0, lines: 0 } : { statements: 78, lines: 80 },
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
