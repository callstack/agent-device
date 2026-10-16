import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { fixture, run } from './execution.fixtures.ts';
import type { TestReport } from './test-report.ts';

test(
  'real Vitest report preserves assertion, suite, and unhandled failures separately',
  { skip: process.platform === 'win32' },
  () => {
    const { cwd: root } = fixture();
    const reporter = pathToFileURL(path.join(import.meta.dirname, 'test-report.ts')).href;
    try {
      fs.writeFileSync(
        path.join(root, 'vitest.config.ts'),
        `
      import { validationTestReporter } from ${JSON.stringify(reporter)};
      export default { test: { root: ${JSON.stringify(root)}, maxWorkers: 1,
        reporters: ['dot', validationTestReporter(process.env.AGENT_DEVICE_VALIDATION_REPORT + '.' + process.pid + '.json')] } };
    `,
      );
      fs.writeFileSync(
        path.join(root, 'cases.test.js'),
        `
      import { test, expect, describe, beforeAll } from 'vitest';
      test('passes', { skip: process.platform === 'win32' }, () => expect(1).toBe(1));
      test('assertion', { skip: process.platform === 'win32' }, () => expect(1).toBe(2));
      test('unhandled', { skip: process.platform === 'win32' }, async () => { Promise.reject(new Error('fixture-unhandled')); await new Promise(r => setTimeout(r, 10)); });
      describe('suite', () => { beforeAll(() => { throw new Error('fixture-suite'); }); test('not reached', { skip: process.platform === 'win32' }, () => {}); });
    `,
      );
      const result = run(
        root,
        'HEAD',
        `return execute(['pnpm', 'exec', 'vitest', 'run', '--config', ${JSON.stringify(path.join(root, 'vitest.config.ts'))}], ${JSON.stringify(path.resolve(import.meta.dirname, '../..'))}, 'report');`,
      );
      assert.equal(result.exitCode, 1);
      const check = result.receipt.results[0]!;
      assert.equal(check.testReportPaths?.length, 1);
      const report = check.tests?.[0] as TestReport;
      assert.equal(report.passed, 2);
      assert.ok(report.failed >= 1);
      assert.equal(report.unhandledErrors, 1);
      assert.ok(
        report.failures.some(
          (failure) => failure.kind === 'test' && failure.test?.includes('assertion'),
        ),
      );
      assert.ok(
        report.failures.some(
          (failure) => failure.kind === 'suite' && failure.errors.join().includes('fixture-suite'),
        ),
      );
      assert.ok(
        report.failures.some(
          (failure) =>
            failure.kind === 'unhandled' && failure.errors.join().includes('fixture-unhandled'),
        ),
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);
