import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'vitest';
import { runCliCapture } from '../../../__tests__/cli-capture.ts';
import { mkdtempForTest } from '../../../__tests__/test-utils/tmp-dir.ts';

test.each([false, true])('CLI refuses a wrapping reporter exit code (json=%s)', async (json) => {
  const root = await mkdtempForTest('agent-device-reporter-exit-');
  const flow = path.join(root, 'flow.ad');
  const reporter = path.join(root, 'reporter.mjs');
  await fs.writeFile(flow, 'open Demo\n');
  await fs.writeFile(reporter, "export default { name: 'wrapping', getExitCode: () => 256 };\n");
  const failed = {
    file: flow,
    session: 'test:reporter',
    status: 'failed',
    durationMs: 1,
    attempts: 1,
    error: { message: 'fixture assertion failed' },
  };
  const result = await runCliCapture(
    ['test', flow, '--reporter', reporter, ...(json ? ['--json'] : [])],
    async () => ({
      ok: true,
      data: {
        total: 1,
        executed: 1,
        passed: 0,
        failed: 1,
        skipped: 0,
        notRun: 0,
        durationMs: 1,
        failures: [failed],
        tests: [failed],
      },
    }),
  );

  assert.equal(result.calls.length, 1);
  assert.equal(result.calls[0]?.command, 'test');
  assert.equal(result.code, 1);
  if (json) {
    const output = JSON.parse(result.stdout);
    assert.equal(output.success, false);
    assert.equal(output.error.code, 'INVALID_ARGS');
    assert.match(output.error.message, /wrapping.*getExitCode.*0 to 255/);
  } else {
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /INVALID_ARGS/);
    assert.match(result.stderr, /wrapping.*getExitCode.*0 to 255/);
  }
});
