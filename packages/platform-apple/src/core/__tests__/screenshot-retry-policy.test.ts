import { test } from 'vitest';
import assert from 'node:assert/strict';
import { AppError } from '@agent-device/kernel/errors';
import { shouldRetryIosSimulatorScreenshot } from '../screenshot.ts';
import { SIMCTL_SCREENSHOT_TIMEOUT_REASON } from '../tool-provider.ts';

test('shouldRetryIosSimulatorScreenshot retries the timeout reason the adapter stamps', () => {
  // The reason the local simctl adapter stamps from the tool's protocol header; see
  // screenshot-simctl-protocol.test.ts for the producer that mints it.
  const error = new AppError('COMMAND_FAILED', 'xcrun exited with code 60', {
    stderr: 'Timeout waiting for screen surfaces',
    exitCode: 60,
    reason: SIMCTL_SCREENSHOT_TIMEOUT_REASON,
  });
  assert.equal(shouldRetryIosSimulatorScreenshot(error), true);
});

test('shouldRetryIosSimulatorScreenshot retries a command host-kit killed at its deadline', () => {
  const error = new AppError('COMMAND_FAILED', 'xcrun timed out after 20000ms', {
    args: ['simctl', 'io', 'sim-1', 'screenshot', '/tmp/out.png'],
    timeoutMs: 20_000,
  });
  assert.equal(shouldRetryIosSimulatorScreenshot(error), true);
});

test('shouldRetryIosSimulatorScreenshot ignores unrelated screenshot failures', () => {
  const error = new AppError('COMMAND_FAILED', 'Failed to capture iOS screenshot', {
    stderr: 'No such file or directory',
    exitCode: 2,
  });
  assert.equal(shouldRetryIosSimulatorScreenshot(error), false);
});

test('the same screenshot timeout wording without the typed reason is not retryable', () => {
  // Identical wording and argv to the two positives above, minus the typed evidence: the retry
  // decision must not be reachable from the tool's prose or from this module's own argv.
  const worded = new AppError('COMMAND_FAILED', 'Detected file type from extension: PNG', {
    stderr: 'Timeout waiting for screen surfaces',
    exitCode: 60,
  });
  const wordedAndSpelled = new AppError('COMMAND_FAILED', 'xcrun timed out after 20000ms', {
    args: ['simctl', 'io', 'sim-1', 'screenshot', '/tmp/out.png'],
    stderr: 'Timeout waiting for screen surfaces',
    exitCode: 60,
  });
  assert.equal(shouldRetryIosSimulatorScreenshot(worded), false);
  assert.equal(shouldRetryIosSimulatorScreenshot(wordedAndSpelled), false);
});
