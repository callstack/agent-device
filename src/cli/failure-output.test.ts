import assert from 'node:assert/strict';
import { test } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import { withCapturedStderrAsync } from '@agent-device/test-kit';
import { printHumanError } from './failure-output.ts';

test('printHumanError writes a body-less failure as its one summary line', async () => {
  const stderr = await withCapturedStderrAsync(async () => {
    await printHumanError(
      new AppError('COMMAND_FAILED', 'Could not reach the app', { hint: 'Open the app first.' }),
    );
  });

  assert.equal(
    stderr,
    'Error (COMMAND_FAILED): Could not reach the app. Next: Open the app first.\n',
  );
});

// Callers merge stderr into stdout and keep `tail -1` or `head -1`; both must be the summary.
test('printHumanError closes a multi-line failure with the same summary line', async () => {
  const stderr = await withCapturedStderrAsync(async () => {
    await printHumanError(
      new AppError('COMMAND_FAILED', 'boom', { logPath: '/tmp/req.ndjson', dispatched: 'unknown' }),
    );
  });

  const lines = stderr.trimEnd().split('\n');
  assert.deepEqual(lines, [
    'Error (COMMAND_FAILED): boom. May have reached the device. Next: Run snapshot to check the screen before you retry. Read the diagnostics log for the failing step.',
    'Log: /tmp/req.ndjson',
    'Error (COMMAND_FAILED): boom. May have reached the device. Next: Run snapshot to check the screen before you retry. Read the diagnostics log for the failing step.',
  ]);
});
