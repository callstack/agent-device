import assert from 'node:assert/strict';
import { test } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import { withCapturedStderrAsync } from '@agent-device/test-kit';
import { printHumanError } from './human-error.ts';

test('printHumanError writes each error line to stderr, newline-terminated', async () => {
  const stderr = await withCapturedStderrAsync(async () => {
    printHumanError(
      new AppError('COMMAND_FAILED', 'Could not reach the app', { hint: 'Open the app first.' }),
    );
  });

  assert.equal(
    stderr,
    'Error (COMMAND_FAILED): Could not reach the app\nHint: Open the app first.\n',
  );
});
