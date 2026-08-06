import assert from 'node:assert/strict';
import { test } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import {
  RUNNER_ERROR_RULES,
  isRetryableRunnerError,
  resolveRunnerFatalErrorReason,
  shouldRestartRunnerBeforeCommandSend,
  shouldRetryRunnerConnectError,
} from '../runner/runner-contract.ts';

function commandFailed(message: string, details?: Record<string, unknown>): AppError {
  return new AppError('COMMAND_FAILED', message, details);
}

test('every rule carries a unique reason', () => {
  const reasons = RUNNER_ERROR_RULES.map((rule) => rule.reason);
  assert.equal(new Set(reasons).size, reasons.length);
});

// --- retryable axis (isRetryableRunnerError) ---

test('transport-shaped failures are retryable', () => {
  for (const message of [
    'Runner did not accept connection on port 8100',
    'fetch failed',
    'connect ECONNREFUSED 127.0.0.1:8100',
    'socket hang up',
  ]) {
    assert.equal(isRetryableRunnerError(commandFailed(message)), true, message);
  }
});

test('boot-shaped failures are not retryable', () => {
  assert.equal(isRetryableRunnerError(commandFailed('xcodebuild exited early (code 65)')), false);
  assert.equal(
    isRetryableRunnerError(commandFailed('Device is busy (Connecting to Simulator)')),
    false,
  );
});

test('an explicitly retriable flag wins over any message denial', () => {
  const flagged = commandFailed('xcodebuild exited early', { retriable: true });
  assert.equal(isRetryableRunnerError(flagged), true);
});

test('retryable requires an AppError with COMMAND_FAILED', () => {
  assert.equal(isRetryableRunnerError(new Error('fetch failed')), false);
  assert.equal(isRetryableRunnerError(new AppError('DEVICE_NOT_FOUND', 'fetch failed')), false);
});

// --- connect-retry axis (shouldRetryRunnerConnectError) ---

test('connect loop keeps waiting by default, including for unknown errors', () => {
  assert.equal(
    shouldRetryRunnerConnectError(commandFailed('Runner did not accept connection')),
    true,
  );
  assert.equal(shouldRetryRunnerConnectError(new Error('anything')), true);
  assert.equal(shouldRetryRunnerConnectError(new AppError('INVALID_ARGS', 'nope')), true);
});

test('connect loop stops for terminal verdicts', () => {
  assert.equal(shouldRetryRunnerConnectError(commandFailed('xcodebuild exited early')), false);
  const unattached = new AppError('DEVICE_NOT_FOUND', 'device not attached', {
    usbmuxDeviceAttached: false,
  });
  assert.equal(shouldRetryRunnerConnectError(unattached), false);
  // The same code without the usbmux evidence keeps waiting.
  assert.equal(shouldRetryRunnerConnectError(new AppError('DEVICE_NOT_FOUND', 'gone')), true);
});

// --- session-fatal axis (resolveRunnerFatalErrorReason) ---

test('session-fatal codes map to their invalidation reasons', () => {
  assert.equal(
    resolveRunnerFatalErrorReason(new AppError('IOS_AX_SNAPSHOT_FAILED', 'ax root failed')),
    'ax_snapshot_failure',
  );
  assert.equal(
    resolveRunnerFatalErrorReason(new AppError('XCTEST_RECORDED_FAILURE', 'recorded failure')),
    'xctest_recorded_failure',
  );
  assert.equal(
    resolveRunnerFatalErrorReason(new AppError('RUNNER_WEDGED', 'main thread stuck')),
    'runner_main_thread_wedged',
  );
});

test('ordinary errors are never session-fatal', () => {
  assert.equal(resolveRunnerFatalErrorReason(commandFailed('socket hang up')), undefined);
  assert.equal(resolveRunnerFatalErrorReason(new Error('boom')), undefined);
});

// --- restart-before-send axis (shouldRestartRunnerBeforeCommandSend) ---

test('a refused connection before send restarts the session, case-insensitively', () => {
  assert.equal(
    shouldRestartRunnerBeforeCommandSend(commandFailed('Runner did not accept connection')),
    true,
  );
  assert.equal(
    shouldRestartRunnerBeforeCommandSend(commandFailed('runner did not accept connection')),
    true,
  );
});

test('a terminal connect verdict refuses the restart even when the message matches', () => {
  const both = commandFailed('xcodebuild exited early: runner did not accept connection');
  assert.equal(shouldRestartRunnerBeforeCommandSend(both), false);
  assert.equal(shouldRestartRunnerBeforeCommandSend(commandFailed('socket hang up')), false);
});
