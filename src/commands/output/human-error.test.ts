import assert from 'node:assert/strict';
import { test } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import { withCapturedStderrAsync } from '@agent-device/test-kit';
import { printHumanError } from './human-error.ts';

test('printHumanError writes a body-less failure as its one summary line', async () => {
  const stderr = await withCapturedStderrAsync(async () => {
    printHumanError(
      new AppError('COMMAND_FAILED', 'Could not reach the app', { hint: 'Open the app first.' }),
    );
  });

  assert.equal(
    stderr,
    'Error (COMMAND_FAILED): Could not reach the app. Next: Open the app first.\n',
  );
});

// Callers merge stderr into stdout and keep `tail -1` or `head -1`; both must be the summary.
test('printHumanError closes a multi-line failure with the summary, after any trailer', async () => {
  const stderr = await withCapturedStderrAsync(async () => {
    printHumanError(
      new AppError('COMMAND_FAILED', 'boom', { logPath: '/tmp/req.ndjson', dispatched: 'unknown' }),
      { trailer: '\n[daemon log]\nlast daemon line' },
    );
  });

  const lines = stderr.trimEnd().split('\n');
  assert.match(
    lines[0] ?? '',
    /^Error \(COMMAND_FAILED\): boom\. May have reached the device\. Next: /,
  );
  assert.equal(lines.at(-1), lines[0]);
  assert.ok(lines.indexOf('last daemon line') < lines.length - 1);
  assert.ok(lines.includes('Log: /tmp/req.ndjson'));
});
