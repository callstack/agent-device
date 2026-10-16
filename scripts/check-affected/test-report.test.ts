import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { runCmdSync } from '@agent-device/host-kit/command';
import type { TestReport } from './test-report.ts';

test('real Vitest report preserves assertion, suite, and unhandled failures separately', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'validation-report-'));
  const reportPath = path.join(root, 'report.json');
  const reporter = pathToFileURL(path.join(import.meta.dirname, 'test-report.ts')).href;
  try {
    fs.writeFileSync(
      path.join(root, 'vitest.config.ts'),
      `
      import { validationTestReporter } from ${JSON.stringify(reporter)};
      export default { test: { root: ${JSON.stringify(root)}, maxWorkers: 1,
        reporters: ['dot', validationTestReporter(${JSON.stringify(reportPath)})] } };
    `,
    );
    fs.writeFileSync(
      path.join(root, 'cases.test.js'),
      `
      import { test, expect, describe, beforeAll } from 'vitest';
      test('passes', () => expect(1).toBe(1));
      test('assertion', () => expect(1).toBe(2));
      test('unhandled', async () => { Promise.reject(new Error('fixture-unhandled')); await new Promise(r => setTimeout(r, 10)); });
      describe('suite', () => { beforeAll(() => { throw new Error('fixture-suite'); }); test('not reached', () => {}); });
    `,
    );
    const result = runCmdSync(
      'pnpm',
      ['exec', 'vitest', 'run', '--config', path.join(root, 'vitest.config.ts')],
      {
        cwd: path.resolve(import.meta.dirname, '../..'),
        allowFailure: true,
        env: { ...process.env, AGENT_DEVICE_VALIDATION_REPORT: '' },
      },
    );
    assert.equal(result.exitCode, 1);
    assert.ok(fs.existsSync(reportPath), result.stderr + result.stdout);
    const report = JSON.parse(fs.readFileSync(reportPath, 'utf8')) as TestReport;
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
});
