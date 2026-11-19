import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'vitest';
import { runCliCapture } from '../../../__tests__/cli-capture.ts';
import {
  mkdtempForTest,
  withCapturedStderr,
  withCapturedStderrAsync,
} from '@agent-device/test-kit';
import { createReplayTestReporterRuntime } from '../reporting.ts';

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

test('a test run prints command progress, such as an upload, to stderr escaped', async () => {
  const runtime = await createReplayTestReporterRuntime({});

  const stderr = withCapturedStderr(() => {
    runtime.onProgress({
      type: 'command',
      status: 'progress',
      message: 'Uploading app\u001b[8m.apk (10 B) via direct upload',
    });
  });

  assert.equal(stderr, String.raw`Uploading app\u001b[8m.apk (10 B) via direct upload` + '\n');
});

test('in a terminal, a test run writes command progress on its own row after a drawn live row', async () => {
  const previousCi = process.env.CI;
  delete process.env.CI;
  try {
    const stderr = await withCapturedStderrAsync(
      async () => {
        const runtime = await createReplayTestReporterRuntime({});
        runtime.onProgress({
          type: 'replay-test',
          file: '/tmp/checkout.yaml',
          title: 'Checkout',
          status: 'progress',
          index: 1,
          total: 1,
          stepIndex: 1,
          stepTotal: 2,
          stepCommand: 'tapOn',
        });
        runtime.onProgress({ type: 'command', status: 'progress', message: 'Uploading app.apk' });
        await runtime.reporters[0]?.onSuiteEnd?.(
          {
            total: 0,
            executed: 0,
            passed: 0,
            failed: 0,
            skipped: 0,
            notRun: 0,
            durationMs: 0,
            failures: [],
            tests: [],
          },
          runtime.context,
        );
      },
      { interactive: true },
    );

    assert.ok(stderr.includes('\r\u001B[2KUploading app.apk\n'), JSON.stringify(stderr));
  } finally {
    if (previousCi !== undefined) process.env.CI = previousCi;
  }
});
