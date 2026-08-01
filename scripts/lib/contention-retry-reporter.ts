// Failure sink for the contention single-retry policy (#1419): writes each
// failed test with its retry eligibility, plus every failure that is not a
// failed test case. Enabled by `CONTENTION_RETRY_FAILURES`; module ids are
// written as-is and `parseFailureReport` makes them repo-relative.

import fs from 'node:fs';
import path from 'node:path';
import type { Reporter, TestCase, TestModule } from 'vitest/node';
import { isRunnerTimeout, type RunBlocker, type TestFailure } from './contention-retry.ts';
import { drainRunBlockers } from './run-blocker-bus.ts';
import { RUNNER_TIMEOUT_TOKEN_ENV } from './runner-timeout-meta.ts';

export const FAILURE_FILE_ENV = 'CONTENTION_RETRY_FAILURES';

export type FailureReport = { failures: TestFailure[]; blockers: RunBlocker[] };

/** The failed-test view of a Vitest test case, or null when it did not fail. */
export function failedTestCase(testCase: TestCase, token: string | undefined): TestFailure | null {
  const result = testCase.result();
  if (result.state !== 'failed') return null;
  const errors = result.errors ?? [];
  return {
    file: (testCase.module as TestModule).moduleId,
    testName: testCase.fullName,
    message: errors.map((error) => `${error.name}: ${error.message}`).join('\n'),
    timeout: isRunnerTimeout(errors, testCase.meta(), token),
  };
}

/** Failures that rerunning the failed files cannot re-check. */
export function runBlockers(
  testModules: readonly TestModule[],
  unhandledErrors: readonly { name?: unknown; message?: unknown }[],
): RunBlocker[] {
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
      const failed = failedTestCase(testCase, process.env[RUNNER_TIMEOUT_TOKEN_ENV]);
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
