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

test('printHumanError keeps the diagnostics footer off the default tier', async () => {
  const stderr = await withCapturedStderrAsync(async () => {
    printHumanError(
      new AppError('COMMAND_FAILED', 'Could not reach the app', {
        diagnosticId: 'diag-123',
        logPath: '/tmp/diag.ndjson',
      }),
    );
  });

  assert.equal(stderr.includes('Diagnostic ID:'), false);
  assert.equal(stderr.includes('Diagnostics Log:'), false);
  assert.equal(stderr.startsWith('Error (COMMAND_FAILED): Could not reach the app\n'), true);
});

test('printHumanError renders the diagnostics footer when the debug tier asks for it', async () => {
  const stderr = await withCapturedStderrAsync(async () => {
    printHumanError(
      new AppError('COMMAND_FAILED', 'Could not reach the app', {
        diagnosticId: 'diag-123',
        logPath: '/tmp/diag.ndjson',
      }),
      { debugTier: true },
    );
  });

  assert.match(stderr, /^Error \(COMMAND_FAILED\): Could not reach the app\n/);
  assert.match(stderr, /Diagnostic ID: diag-123\n/);
  assert.match(stderr, /Diagnostics Log: \/tmp\/diag\.ndjson\n/);
});
