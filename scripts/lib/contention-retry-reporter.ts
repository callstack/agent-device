// Failure sink for the contention single-retry policy (#1419).
//
// The lane needs two things no built-in reporter gives it together: each failed
// test's *live* error object (so a timeout is classified structurally rather
// than from rendered text — Vitest's `json` reporter serializes a timeout as a
// bare `STACK_TRACE_ERROR`), and every failure that is not a failed test case.
// The latter are recorded as blockers, which forbid a retry outright: without
// them a timeout retry could turn a run green that also failed for an unrelated
// reason.
//
// Composed into the configured reporters by vitest.config.ts whenever
// `CONTENTION_RETRY_FAILURES` is set, so the slow-test gate stays in the lane.
// Module ids are written as-is; `parseFailureReport` makes them repo-relative.

import fs from 'node:fs';
import path from 'node:path';
import type { Reporter, TestCase, TestModule } from 'vitest/node';
import { isRunnerTimeout, type RunBlocker, type TestFailure } from './contention-retry.ts';
import { drainRunBlockers } from './run-blocker-bus.ts';

export const FAILURE_FILE_ENV = 'CONTENTION_RETRY_FAILURES';

export type FailureReport = { failures: TestFailure[]; blockers: RunBlocker[] };

/** The failed-test view of a Vitest test case, or null when it did not fail. */
export function failedTestCase(testCase: TestCase): TestFailure | null {
  const result = testCase.result();
  if (result.state !== 'failed') return null;
  const errors = result.errors ?? [];
  return {
    file: (testCase.module as TestModule).moduleId,
    testName: testCase.fullName,
    message: errors.map((error) => `${error.name}: ${error.message}`).join('\n'),
    // Decided from runner metadata (budget consumed) plus the error shape, so
    // test code cannot forge it; a test that timed out *and* failed an assertion
    // is not retry-eligible either.
    timeout: isRunnerTimeout(errors, {
      timeoutMs: testCase.options.timeout,
      durationMs: testCase.diagnostic()?.duration,
    }),
  };
}

/**
 * Failures that no rerun of the failed files can re-check: verdicts published by
 * other gate reporters, unhandled errors, and modules that failed outside a test
 * case (import/setup/teardown errors, which report no failed test at all).
 */
export function runBlockers(
  testModules: readonly TestModule[],
  unhandledErrors: readonly { name?: unknown; message?: unknown }[],
): RunBlocker[] {
  // Gate reporters that fail the run without failing a test publish here.
  const blockers: RunBlocker[] = drainRunBlockers();
  for (const error of unhandledErrors) {
    blockers.push({
      kind: 'unhandled error',
      detail:
        `${String(error.name ?? 'Error')}: ${String(error.message ?? '')}`.split('\n')[0] ?? '',
    });
  }
  for (const testModule of testModules) {
    for (const error of testModule.errors()) {
      blockers.push({
        kind: 'module error',
        detail: `${testModule.moduleId}: ${String(error.message ?? '').split('\n')[0] ?? ''}`,
      });
    }
  }
  return blockers;
}

export function writeFailureReport(report: FailureReport, target: string): void {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(report)}\n`);
}

export default function contentionRetryReporter(): Reporter {
  const failures: TestFailure[] = [];
  return {
    onTestCaseResult(testCase: TestCase): void {
      const failed = failedTestCase(testCase);
      if (failed) failures.push(failed);
    },
    onTestRunEnd(
      testModules: readonly TestModule[],
      unhandledErrors: readonly { name?: unknown; message?: unknown }[],
    ): void {
      const target = process.env[FAILURE_FILE_ENV];
      if (!target) return;
      writeFailureReport({ failures, blockers: runBlockers(testModules, unhandledErrors) }, target);
    },
  };
}
