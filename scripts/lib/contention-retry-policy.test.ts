// Gate for the contention single-retry policy (#1419). A retry that can hide an
// assertion failure is worse than no retry at all, so both halves are asserted
// here: the shape of the enumerated list (owned waivers, real files, no globs)
// and the decisions the lane makes from a failed run.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { runWithContentionRetry, type TestRun } from './contention-retry-lane.ts';
import { processBlockers } from './contention-retry-blockers.ts';
import contentionRetryReporter, {
  failedTestCase,
  runBlockers,
  writeFailureReport,
} from './contention-retry-reporter.ts';
import {
  CONTENTION_RETRY_FILES,
  expiredRetryEntries,
  formatRetrySummary,
  isRunnerTimeout,
  parseFailureReport,
  planContentionRetry,
  SUBPROCESS_STUB_TESTS,
  type TestFailure,
} from './contention-retry.ts';

const repoRoot = path.resolve(import.meta.dirname, '../..');

const LISTED = 'src/daemon/__tests__/request-router-open.test.ts';
// Vitest's own timeout error, verbatim (@vitest/runner `makeTimeoutError`).
const VITEST_TIMEOUT = {
  name: 'Error',
  message:
    'Test timed out in 5000ms.\nIf this is a long-running test, pass a timeout value as the last argument or configure it globally with "testTimeout".',
};
const TIMEOUT_MESSAGE = `Error: ${VITEST_TIMEOUT.message}`;
const ASSERTION_MESSAGE = 'AssertionError: expected "DEVICE_IN_USE" to be "OK"';

function failure(overrides: Partial<TestFailure> = {}): TestFailure {
  return {
    file: LISTED,
    testName: 'opens a session',
    message: TIMEOUT_MESSAGE,
    timeout: true,
    ...overrides,
  };
}

function assertionFailure(overrides: Partial<TestFailure> = {}): TestFailure {
  return failure({ message: ASSERTION_MESSAGE, timeout: false, ...overrides });
}

const TIMEOUT_MS = 5000;

function testCaseStub(
  errors: ReadonlyArray<Record<string, unknown>>,
  overrides: { state?: string; timeoutMs?: number; durationMs?: number } = {},
): unknown {
  return {
    fullName: 'opens a session',
    module: { moduleId: `${repoRoot}/${LISTED}` },
    options: { timeout: overrides.timeoutMs ?? TIMEOUT_MS },
    diagnostic: () => ({ duration: overrides.durationMs ?? TIMEOUT_MS + 4 }),
    result: () => ({ state: overrides.state ?? 'failed', errors }),
  };
}

const RAN_TO_BUDGET = { timeoutMs: TIMEOUT_MS, durationMs: TIMEOUT_MS + 4 };

function lane(runs: { first: TestRun; retry?: TestRun; today?: Date }): {
  result: ReturnType<typeof runWithContentionRetry>;
  rerun: string[][];
} {
  const rerun: string[][] = [];
  const result = runWithContentionRetry({
    runAll: () => Promise.resolve(runs.first),
    runFiles: (files) => {
      rerun.push([...files]);
      return Promise.resolve(runs.retry ?? { ok: true, failures: [] });
    },
    commit: 'c'.repeat(40),
    configHash: 'sha256:deadbeef',
    vitestVersion: '4.1.8',
    startedAtMs: 0,
    now: () => 1_000,
    today: runs.today,
  });
  return { result, rerun };
}

test('every retry-list entry is an owned waiver naming why the file spawns or waits', () => {
  for (const entry of CONTENTION_RETRY_FILES) {
    assert.ok(
      fs.existsSync(path.join(repoRoot, entry.file)),
      `${entry.file} does not exist — remove the retry entry with the test`,
    );
    assert.ok(
      !/[*?{}[\]]/.test(entry.file),
      `${entry.file} looks like a glob; the retry set is enumerated`,
    );
    assert.match(
      entry.reason,
      /spawn|wait|poll|socket/i,
      `${entry.file} must name the spawn/wait that makes it contention-flaky`,
    );
    assert.match(
      entry.trackingIssue,
      /^https:\/\/github\.com\/callstack\/agent-device\/issues\/\d+$/,
    );
    assert.match(entry.reviewBy, /^\d{4}-\d{2}-\d{2}$/);
  }
  const files = CONTENTION_RETRY_FILES.map((entry) => entry.file);
  assert.equal(new Set(files).size, files.length, 'duplicate retry entries');
});

test('the repeat offenders and every subprocess-stub file are retry-eligible', () => {
  const files = new Set(CONTENTION_RETRY_FILES.map((entry) => entry.file));
  for (const offender of [
    'src/daemon/__tests__/request-router-open.test.ts',
    'src/platforms/apple/core/__tests__/runner-client.test.ts',
    'src/platforms/apple/core/__tests__/runner-xctestrun.test.ts',
    'scripts/__tests__/help-conformance-bench.test.ts',
  ]) {
    assert.ok(files.has(offender), `${offender} must stay retry-eligible`);
  }
  for (const stub of SUBPROCESS_STUB_TESTS) assert.ok(files.has(stub));
  assert.ok(SUBPROCESS_STUB_TESTS.length < CONTENTION_RETRY_FILES.length);
});

test('vitest projects read the shared constant instead of re-listing globs', () => {
  const config = fs.readFileSync(path.join(repoRoot, 'vitest.config.ts'), 'utf8');
  assert.match(config, /from '\.\/scripts\/lib\/contention-retry\.ts'/);
});

test('an expired waiver fails the gate; the committed list is not expired', () => {
  assert.deepEqual(expiredRetryEntries(new Date()), []);
  const expired = expiredRetryEntries(new Date('2099-01-01T00:00:00Z'));
  assert.equal(expired.length, CONTENTION_RETRY_FILES.length);
});

test('the expiry gate fails the run before any test executes', async () => {
  const { result, rerun } = lane({
    first: { ok: false, failures: [failure()] },
    today: new Date('2099-01-01T00:00:00Z'),
  });
  const resolved = await result;
  assert.equal(resolved.ok, false);
  assert.match(resolved.summary, /Retry list expired/);
  assert.deepEqual(rerun, []);
});

test('only a test the runner aborted at its own budget classifies as a timeout', () => {
  assert.ok(isRunnerTimeout([VITEST_TIMEOUT], RAN_TO_BUDGET));
  assert.ok(
    isRunnerTimeout(
      [
        {
          name: 'Error',
          message:
            'Hook timed out in 10000ms.\nIf this is a long-running hook, pass a timeout value as the last argument or configure it globally with "hookTimeout".',
        },
      ],
      RAN_TO_BUDGET,
    ),
  );
  // Runner metadata is the primary evidence: test code cannot make its own
  // failure consume the whole configured budget and still choose the error.
  assert.ok(!isRunnerTimeout([VITEST_TIMEOUT], { timeoutMs: TIMEOUT_MS, durationMs: 12 }));
  assert.ok(!isRunnerTimeout([VITEST_TIMEOUT], { timeoutMs: undefined, durationMs: 99_999 }));
  assert.ok(!isRunnerTimeout([VITEST_TIMEOUT], { timeoutMs: 0, durationMs: 0 }));
  assert.ok(!isRunnerTimeout([], RAN_TO_BUDGET));
  // An assertion must not be able to talk its way into a retry, whatever it says.
  for (const impostor of [
    { name: 'AssertionError', message: VITEST_TIMEOUT.message },
    { name: 'AssertionError', message: 'expected ETIMEDOUT, got ECONNRESET' },
    { name: 'Error', message: `saw: ${VITEST_TIMEOUT.message}` },
    { name: 'Error', message: 'connect ETIMEDOUT 127.0.0.1:8080' },
    { name: 'Error', message: 'Closing timeout while tearing down the daemon' },
    { name: 'Error', message: VITEST_TIMEOUT.message, expected: 'OK', actual: 'DEVICE_IN_USE' },
  ]) {
    assert.ok(!isRunnerTimeout([impostor], RAN_TO_BUDGET), `${impostor.name}: ${impostor.message}`);
  }
});

test('an exact-template Error thrown by the test itself never retries', async () => {
  // The forgery the classifier must refuse: right name, right message, right
  // shape — but the test returned long before its budget was up.
  const forged = failedTestCase(
    testCaseStub([{ name: 'Error', message: VITEST_TIMEOUT.message }], { durationMs: 7 }) as never,
  );
  assert.ok(forged);
  assert.equal(forged.timeout, false, 'a hand-thrown timeout message is not a runner timeout');
  const { result, rerun } = lane({ first: { ok: false, failures: [{ ...forged, file: LISTED }] } });
  const resolved = await result;
  assert.equal(resolved.ok, false);
  assert.deepEqual(rerun, []);
  assert.equal(resolved.envelope.data.retryCount, 0);
});

test('an assertion message quoting a timeout still fails on the first run', async () => {
  const impostor = failedTestCase(
    testCaseStub([{ name: 'AssertionError', message: VITEST_TIMEOUT.message }]) as never,
  );
  assert.ok(impostor);
  assert.equal(impostor.timeout, false);
  const { result, rerun } = lane({
    first: { ok: false, failures: [{ ...impostor, file: LISTED }] },
  });
  assert.equal((await result).ok, false);
  assert.deepEqual(rerun, []);
});

test('a test that timed out AND failed an assertion is not retry-eligible', () => {
  const mixed = failedTestCase(
    testCaseStub([
      VITEST_TIMEOUT,
      { name: 'AssertionError', message: 'expected 1 to be 2', expected: 2, actual: 1 },
    ]) as never,
  );
  assert.equal(mixed?.timeout, false);
});

test('the lane reporter keeps the real error message a timeout is classified by', () => {
  const failed = failedTestCase(testCaseStub([VITEST_TIMEOUT]) as never);
  assert.deepEqual(failed, {
    file: `${repoRoot}/${LISTED}`,
    testName: 'opens a session',
    message: TIMEOUT_MESSAGE,
    timeout: true,
  });
  assert.equal(failedTestCase(testCaseStub([], { state: 'passed' }) as never), null);

  const target = path.join(repoRoot, '.tmp/contention-retry/reporter-gate.json');
  writeFailureReport({ failures: [failure()], blockers: [] }, target);
  assert.deepEqual(parseFailureReport(JSON.parse(fs.readFileSync(target, 'utf8')), repoRoot), {
    failures: [failure()],
    blockers: [],
  });
  assert.ok(contentionRetryReporter().onTestCaseResult);
});

test('the Coverage lane keeps the configured reporters, failure sink included', async () => {
  const { reporters } = await import('../../vitest.config.ts');
  const plain = reporters({});
  const laneReporters = reporters({ CONTENTION_RETRY_FAILURES: '/tmp/failures.json' });
  assert.equal(plain.length, 2, 'default + slow-test gate');
  assert.equal(
    laneReporters.length,
    plain.length + 1,
    'the failure sink is added, never substituted',
  );
  // The slow-test gate must survive into the retry lane.
  assert.ok(laneReporters.every((reporter) => Boolean(reporter)));
  assert.ok(typeof laneReporters.at(-1) === 'object');
  const runner = fs.readFileSync(
    path.join(repoRoot, 'scripts/lib/contention-retry-run.ts'),
    'utf8',
  );
  assert.ok(
    !/['"]--reporter/.test(runner),
    'a --reporter flag replaces the configured reporters and would drop the slow-test gate',
  );
});

test('non-test failures block the retry instead of being rerun away', async () => {
  const covered = processBlockers({
    ok: false,
    failureCount: 1,
    output: [
      ' Test Files  1 failed (11)',
      'ERROR: Coverage for lines (79.5%) does not meet global threshold (80%)',
    ].join('\n'),
  });
  assert.deepEqual(
    covered.map((blocker) => blocker.kind),
    ['coverage threshold'],
  );
  assert.deepEqual(
    processBlockers({ ok: false, failureCount: 0, output: 'Error: worker exited' }).map(
      (blocker) => blocker.kind,
    ),
    ['unexplained failure'],
  );
  assert.deepEqual(processBlockers({ ok: true, failureCount: 0, output: '' }), []);

  const moduleErrors = runBlockers(
    [
      { moduleId: `${repoRoot}/${LISTED}`, errors: () => [{ message: 'Cannot find module x' }] },
    ] as never,
    [{ name: 'Error', message: 'Unhandled rejection\n at foo' }],
  );
  assert.deepEqual(
    moduleErrors.map((blocker) => blocker.kind),
    ['unhandled error', 'module error'],
  );

  // A retry-eligible timeout alongside any of them still fails the job.
  for (const blockers of [covered, moduleErrors]) {
    const { result, rerun } = lane({ first: { ok: false, failures: [failure()], blockers } });
    const resolved = await result;
    assert.equal(resolved.ok, false);
    assert.deepEqual(rerun, [], 'a blocked run must never be rerun');
    assert.equal(resolved.envelope.data.retryCount, 0);
    assert.match(resolved.summary, /No retry: the run failed for a reason a rerun cannot re-check/);
  }
});

test('a gate that fails the run without failing a test blocks the retry', async () => {
  const { default: slowTestGateReporter } = await import('../vitest-slow-test-reporter.ts');
  const gate = slowTestGateReporter();
  const exitCode = process.exitCode;
  const stderr = console.error;
  console.error = () => {};
  try {
    gate.onInit?.({ config: { root: repoRoot } } as never);
    // Passing, but far past the unit budget: no failed test, run must still fail.
    gate.onTestCaseResult?.({
      name: 'INJECTED slow test',
      fullName: 'INJECTED slow test',
      module: { moduleId: `${repoRoot}/${LISTED}` },
      diagnostic: () => ({ duration: 30_000 }),
      result: () => ({ state: 'passed', errors: [] }),
    } as never);
    gate.onTestRunEnd?.([] as never, [] as never, 'failed' as never);
  } finally {
    console.error = stderr;
    process.exitCode = exitCode;
  }
  // The gate published its verdict on the shared channel; the sink drains it.
  const blockers = runBlockers([], []);
  assert.deepEqual(
    blockers.map((blocker) => blocker.kind),
    ['slow-test gate'],
  );
  assert.deepEqual(runBlockers([], []), [], 'draining is one-shot');

  // A retry-eligible timeout in the same run must not rerun the gate away.
  const { result, rerun } = lane({ first: { ok: false, failures: [failure()], blockers } });
  const resolved = await result;
  assert.equal(resolved.ok, false);
  assert.deepEqual(rerun, []);
  assert.match(resolved.summary, /slow-test gate/);
});

test('two timed-out tests in one file are one retry, counted once', async () => {
  const failures = [failure(), failure({ testName: 'closes a session' })];
  const plan = planContentionRetry(failures);
  assert.deepEqual(plan.retry && plan.files, [LISTED]);
  const { result, rerun } = lane({ first: { ok: false, failures } });
  const resolved = await result;
  assert.deepEqual(rerun, [[LISTED]]);
  assert.equal(resolved.envelope.data.retryCount, 1);
  assert.deepEqual(resolved.envelope.data.retried, [
    {
      file: LISTED,
      testNames: ['opens a session', 'closes a session'],
      trackingIssue: CONTENTION_RETRY_FILES.find((entry) => entry.file === LISTED)?.trackingIssue,
    },
  ]);
  assert.match(resolved.summary, /Retried 1 timeout-shaped file\(s\)/);
  assert.equal(resolved.summary.split('\n').filter((line) => line.includes(LISTED)).length, 1);
});

test('reporter failures are read as repo-relative paths, names, and messages', () => {
  const failures = parseFailureReport(
    {
      failures: [
        {
          file: `${repoRoot}/${LISTED}`,
          testName: 'opens a session',
          message: TIMEOUT_MESSAGE,
          timeout: true,
        },
        { testName: 'no file' },
      ],
    },
    repoRoot,
  );
  assert.deepEqual(failures.failures, [failure()]);
});

test('an unreadable report yields no retry-eligible failures', () => {
  assert.deepEqual(parseFailureReport({}, repoRoot), { failures: [], blockers: [] });
  assert.deepEqual(parseFailureReport({ failures: 'nope' }, repoRoot), {
    failures: [],
    blockers: [],
  });
  assert.equal(planContentionRetry([]).retry, false);
});

test('a timeout in a listed file retries exactly that file, once', () => {
  const plan = planContentionRetry([failure()]);
  assert.deepEqual(plan, { retry: true, files: [LISTED], failures: [failure()] });
});

test('an assertion failure in a listed file never retries', () => {
  const plan = planContentionRetry([assertionFailure()]);
  assert.equal(plan.retry, false);
  assert.match(plan.reason, /assertion failures never retry/);
});

test('a timeout outside the list never retries, even alongside eligible ones', () => {
  const plan = planContentionRetry([
    failure(),
    failure({ file: 'src/daemon/__tests__/session-store.test.ts' }),
  ]);
  assert.equal(plan.retry, false);
  assert.match(plan.reason, /outside the enumerated retry list/);
});

test('an injected assertion failure in a listed file fails the job on the first run', async () => {
  const { result, rerun } = lane({
    first: { ok: false, failures: [assertionFailure()] },
  });
  const resolved = await result;
  assert.equal(resolved.ok, false);
  assert.deepEqual(rerun, [], 'an assertion failure must never be rerun');
  assert.equal(resolved.envelope.data.retryCount, 0);
  assert.equal(resolved.envelope.result, 'fail');
});

test('an injected timeout in a listed file passes on retry with a visible summary line', async () => {
  const { result, rerun } = lane({ first: { ok: false, failures: [failure()] } });
  const resolved = await result;
  assert.equal(resolved.ok, true);
  assert.deepEqual(rerun, [[LISTED]]);
  assert.match(
    resolved.summary,
    /Retried 1 timeout-shaped file\(s\) once — outcome: \*\*passed\*\*/,
  );
  assert.match(resolved.summary, new RegExp(LISTED.replaceAll('.', '\\.')));
  assert.equal(resolved.envelope.data.retryCount, 1);
  assert.equal(resolved.envelope.data.retryOutcome, 'passed');
  assert.equal(resolved.envelope.result, 'pass');
});

test('a file that fails again after its one retry fails the job', async () => {
  const { result } = lane({
    first: { ok: false, failures: [failure()] },
    retry: { ok: false, failures: [failure()] },
  });
  const resolved = await result;
  assert.equal(resolved.ok, false);
  assert.match(resolved.summary, /outcome: \*\*failed\*\*/);
  assert.equal(resolved.envelope.data.retryOutcome, 'failed');
});

test('a green run reports no retry and still emits lane telemetry', async () => {
  const { result } = lane({ first: { ok: true, failures: [] } });
  const resolved = await result;
  assert.equal(resolved.ok, true);
  assert.equal(resolved.summary, '');
  assert.equal(resolved.envelope.lane, 'unit-contention-retry');
  assert.equal(resolved.envelope.data.retryCount, 0);
  assert.equal(resolved.envelope.data.listSize, CONTENTION_RETRY_FILES.length);
});

test('the summary names the tracking issue and review date of every retried file', () => {
  const summary = formatRetrySummary({
    plan: planContentionRetry([failure()]),
    outcome: 'passed',
  });
  const entry = CONTENTION_RETRY_FILES.find((candidate) => candidate.file === LISTED);
  assert.ok(entry);
  assert.match(summary, new RegExp(entry.trackingIssue.replaceAll('/', '\\/')));
  assert.match(summary, new RegExp(entry.reviewBy));
});
