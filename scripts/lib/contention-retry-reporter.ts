// Failure sink for the contention single-retry policy (#1419).
//
// Vitest's built-in `json` reporter serializes a timeout as a bare
// `STACK_TRACE_ERROR`, which is exactly the distinction the policy is built on
// (a timeout may retry, an assertion failure may not), so the lane reads its own
// reporter instead: it keeps each failed test's real error message, and nothing
// else. Enabled per run by the lane entrypoint via `CONTENTION_RETRY_FAILURES`.
//
// Module ids are written as-is; `parseFailureReport` makes them repo-relative.

import fs from 'node:fs';
import path from 'node:path';
import type { Reporter, TestCase, TestModule } from 'vitest/node';
import type { TestFailure } from './contention-retry.ts';

export const FAILURE_FILE_ENV = 'CONTENTION_RETRY_FAILURES';

export type FailureReport = { failures: TestFailure[] };

/** The failed-test view of a Vitest test case, or null when it did not fail. */
export function failedTestCase(testCase: TestCase): TestFailure | null {
  const result = testCase.result();
  if (result.state !== 'failed') return null;
  return {
    file: (testCase.module as TestModule).moduleId,
    testName: testCase.fullName,
    message: (result.errors ?? []).map((error) => `${error.name}: ${error.message}`).join('\n'),
  };
}

export function writeFailureReport(failures: readonly TestFailure[], target: string): void {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify({ failures } satisfies FailureReport)}\n`);
}

export default function contentionRetryReporter(): Reporter {
  const failures: TestFailure[] = [];
  return {
    onTestCaseResult(testCase: TestCase): void {
      const failed = failedTestCase(testCase);
      if (failed) failures.push(failed);
    },
    onTestRunEnd(): void {
      const target = process.env[FAILURE_FILE_ENV];
      if (target) writeFailureReport(failures, target);
    },
  };
}
