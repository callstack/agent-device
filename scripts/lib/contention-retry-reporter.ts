// Failure sink for the contention single-retry policy (#1419).
//
// Vitest's built-in `json` reporter serializes a timeout as a bare
// `STACK_TRACE_ERROR`, which is exactly the distinction the policy is built on
// (a timeout may retry, an assertion failure may not), so the lane reads its own
// reporter instead: it keeps each failed test's real error message, and nothing
// else. Enabled per run by the lane entrypoint via `CONTENTION_RETRY_FAILURES`.

import fs from 'node:fs';
import path from 'node:path';
import type { Reporter, TestCase, TestModule } from 'vitest/node';
import type { TestFailure } from './contention-retry.ts';

export const FAILURE_FILE_ENV = 'CONTENTION_RETRY_FAILURES';

export type FailureReport = { failures: TestFailure[] };

export default function contentionRetryReporter(): Reporter {
  const failures: TestFailure[] = [];
  let root = '';
  return {
    onInit(ctx: { config: { root: string } }): void {
      root = ctx.config.root;
    },
    onTestCaseResult(testCase: TestCase): void {
      const result = testCase.result();
      if (result.state !== 'failed') return;
      const moduleId = (testCase.module as TestModule).moduleId;
      failures.push({
        file: root && moduleId.startsWith(root) ? moduleId.slice(root.length + 1) : moduleId,
        testName: testCase.fullName,
        message: (result.errors ?? [])
          .map((error) => `${error.name ?? 'Error'}: ${error.message}`)
          .join('\n'),
      });
    },
    onTestRunEnd(): void {
      const target = process.env[FAILURE_FILE_ENV];
      if (!target) return;
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, `${JSON.stringify({ failures } satisfies FailureReport)}\n`);
    },
  };
}
