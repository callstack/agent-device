// Gate for the contention single-retry policy (#1419). A retry that can hide an
// assertion failure is worse than no retry at all, so both halves are asserted
// here: the shape of the enumerated list (owned waivers, real files, no globs)
// and the decisions the lane makes from a failed run.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { runWithContentionRetry, type TestRun } from './contention-retry-lane.ts';
import {
  CONTENTION_RETRY_FILES,
  expiredRetryEntries,
  formatRetrySummary,
  isTimeoutShapedFailure,
  planContentionRetry,
  SUBPROCESS_STUB_TESTS,
  type TestFailure,
} from './contention-retry.ts';

const repoRoot = path.resolve(import.meta.dirname, '../..');

const LISTED = 'src/daemon/__tests__/request-router-open.test.ts';
const TIMEOUT_MESSAGE = 'Error: Test timed out in 5000ms.\n at open()';
const ASSERTION_MESSAGE = 'AssertionError: expected "DEVICE_IN_USE" to be "OK"';

function failure(overrides: Partial<TestFailure> = {}): TestFailure {
  return { file: LISTED, testName: 'opens a session', message: TIMEOUT_MESSAGE, ...overrides };
}

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

test('timeout shapes are recognized and assertion failures are not', () => {
  assert.ok(isTimeoutShapedFailure(TIMEOUT_MESSAGE));
  assert.ok(isTimeoutShapedFailure('Error: Hook timed out in 10000 ms.'));
  assert.ok(!isTimeoutShapedFailure(ASSERTION_MESSAGE));
  assert.ok(!isTimeoutShapedFailure('Error: expected timeout hint to be set'));
});

test('a timeout in a listed file retries exactly that file, once', () => {
  const plan = planContentionRetry([failure()]);
  assert.deepEqual(plan, { retry: true, files: [LISTED], failures: [failure()] });
});

test('an assertion failure in a listed file never retries', () => {
  const plan = planContentionRetry([failure({ message: ASSERTION_MESSAGE })]);
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
    first: { ok: false, failures: [failure({ message: ASSERTION_MESSAGE })] },
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
