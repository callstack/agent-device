import assert from 'node:assert/strict';
import { test } from 'vitest';
import { AppError, createRequestCanceledError } from '@agent-device/kernel/errors';
import {
  RUNNER_ERROR_RULES,
  isRetryableRunnerError,
  resolveRunnerFatalErrorReason,
  shouldRebuildCachedRunnerArtifact,
  shouldRestartRunnerAfterReadinessPreflight,
  shouldRestartRunnerBeforeCommandSend,
  shouldRetryRunnerConnectError,
} from '../runner-contract.ts';

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
  assert.equal(
    isRetryableRunnerError(
      commandFailed('Runner did not accept connection (xcodebuild exited early)'),
    ),
    false,
  );
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

// --- readiness preflight ---

test('the preflight marker alone decides the restart', () => {
  // The marker is applied by the preflight's own catch, whatever it was waiting on when it gave
  // up: a killed fallback, an exhausted probe, a refusal. Which of those arrived is not evidence
  // about whether the command reached the runner, and the marker is.
  const killedSpawn = commandFailed('xcrun timed out after 45000ms', {
    cmd: 'xcrun',
    timeoutMs: 45_000,
    runnerReadinessPreflightFailed: true,
  });
  assert.equal(shouldRestartRunnerAfterReadinessPreflight(killedSpawn), true);
  assert.equal(
    shouldRestartRunnerAfterReadinessPreflight(
      commandFailed('Runner readiness refused', { runnerReadinessPreflightFailed: true }),
    ),
    true,
  );
  // The restart the marker authorises is a new session, not more waiting inside this one.
  assert.equal(shouldRetryRunnerConnectError(killedSpawn), true);
  // Without the marker the same two shapes say nothing about the command having been written.
  assert.equal(
    shouldRestartRunnerAfterReadinessPreflight(
      commandFailed('xcrun timed out after 45000ms', { cmd: 'xcrun', timeoutMs: 45_000 }),
    ),
    false,
  );
  assert.equal(
    shouldRestartRunnerAfterReadinessPreflight(commandFailed('Runner readiness refused')),
    false,
  );
  // The same catch marks a caller that stopped waiting. That mark is not a runner that stopped
  // answering: the command was canceled, so no restart has a request left to serve.
  assert.equal(
    shouldRestartRunnerAfterReadinessPreflight(
      createRequestCanceledError({ runnerReadinessPreflightFailed: true }),
    ),
    false,
  );
});

test('a deadline on its own earns no recovery verdict', () => {
  // The same recorded budget covers a wait inside the connect loop, where waiting is
  // right, and a fetch that died after the command was written, where replaying is not.
  const deadline = commandFailed('Runner command deadline exceeded', {
    port: 8100,
    timeoutMs: 45_000,
  });
  assert.equal(isRetryableRunnerError(deadline), false);
  assert.equal(shouldRestartRunnerBeforeCommandSend(deadline), false);
  assert.equal(shouldRestartRunnerAfterReadinessPreflight(deadline), false);
  assert.equal(shouldRebuildCachedRunnerArtifact(deadline), false);
  assert.equal(shouldRetryRunnerConnectError(deadline), true);
});

// --- restored-artifact axis (shouldRebuildCachedRunnerArtifact) ---

test('only a runner that never accepted a connection indicts the cached artifact', () => {
  assert.equal(
    shouldRebuildCachedRunnerArtifact(commandFailed('Runner endpoint probe failed')),
    true,
  );
  assert.equal(
    shouldRebuildCachedRunnerArtifact(commandFailed('Runner did not accept connection')),
    true,
  );
  assert.equal(
    shouldRebuildCachedRunnerArtifact(
      commandFailed('Runner did not accept connection (simctl spawn)', { port: 8100 }),
    ),
    true,
  );
  // Wiping derived data cannot fix a boot that refuses to compile, and its message
  // otherwise reads as a refused connection.
  assert.equal(
    shouldRebuildCachedRunnerArtifact(
      commandFailed('Runner did not accept connection (xcodebuild exited early)', {
        port: 8100,
        logPath: '/tmp/runner.log',
      }),
    ),
    false,
  );
  assert.equal(shouldRebuildCachedRunnerArtifact(commandFailed('fetch failed')), false);
});

test('a device that is busy connecting is a terminal connect verdict', () => {
  assert.equal(
    shouldRetryRunnerConnectError(commandFailed('Device is busy (Connecting to Simulator)')),
    false,
  );
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
