import assert from 'node:assert/strict';
import { test } from 'vitest';
import { AppError, createRequestCanceledError } from '@agent-device/kernel/errors';
import {
  RUNNER_SCREEN_CAPTURE_REFUSAL_RUNNER_CODES,
  classifyRunnerReportedError,
} from '../runner-contract.ts';
import {
  RUNNER_ERROR_RULES,
  isRetryableRunnerError,
  isRunnerBusyError,
  resolveRunnerFatalErrorReason,
  shouldRebuildCachedRunnerArtifact,
  shouldRestartRunnerAfterReadinessPreflight,
  shouldRestartRunnerBeforeCommandSend,
  shouldRetryRunnerConnectError,
} from '../runner-error-classification.ts';
import { runnerConnectFailure } from './runner-session-fixtures.ts';

function commandFailed(message: string, details?: Record<string, unknown>): AppError {
  return new AppError('COMMAND_FAILED', message, details);
}

test('every rule carries a unique reason', () => {
  const reasons = RUNNER_ERROR_RULES.map((rule) => rule.reason);
  assert.equal(new Set(reasons).size, reasons.length);
});

// --- retryable axis (isRetryableRunnerError) ---

test('transport-shaped failures are retryable', () => {
  assert.equal(
    isRetryableRunnerError(
      runnerConnectFailure(
        'runner_connect_refused',
        'Runner did not accept connection on port 8100',
      ),
    ),
    true,
  );
  for (const message of ['fetch failed', 'connect ECONNREFUSED 127.0.0.1:8100', 'socket hang up']) {
    assert.equal(isRetryableRunnerError(commandFailed(message)), true, message);
  }
});

test('boot-shaped failures are not retryable', () => {
  assert.equal(
    isRetryableRunnerError(
      runnerConnectFailure(
        'xcodebuild_exited_early',
        'Runner did not accept connection (xcodebuild exited early)',
      ),
    ),
    false,
  );
  assert.equal(
    isRetryableRunnerError(commandFailed('Device is busy (Connecting to Simulator)')),
    false,
  );
});

test('an explicitly retriable flag wins over any message denial', () => {
  const flagged = runnerConnectFailure('xcodebuild_exited_early', 'xcodebuild exited early', {
    retriable: true,
  });
  assert.equal(isRetryableRunnerError(flagged), true);
});

test('retryable requires an AppError with COMMAND_FAILED', () => {
  assert.equal(isRetryableRunnerError(new Error('fetch failed')), false);
  assert.equal(isRetryableRunnerError(new AppError('DEVICE_NOT_FOUND', 'fetch failed')), false);
});

// --- connect-retry axis (shouldRetryRunnerConnectError) ---

test('connect loop keeps waiting by default, including for unknown errors', () => {
  assert.equal(
    shouldRetryRunnerConnectError(
      runnerConnectFailure('runner_connect_refused', 'Runner did not accept connection'),
    ),
    true,
  );
  assert.equal(shouldRetryRunnerConnectError(new Error('anything')), true);
  assert.equal(shouldRetryRunnerConnectError(new AppError('INVALID_ARGS', 'nope')), true);
});

test('connect loop stops for terminal verdicts', () => {
  assert.equal(
    shouldRetryRunnerConnectError(
      runnerConnectFailure('xcodebuild_exited_early', 'xcodebuild exited early'),
    ),
    false,
  );
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
    shouldRebuildCachedRunnerArtifact(
      runnerConnectFailure('runner_endpoint_probe_exhausted', 'Runner endpoint probe failed'),
    ),
    true,
  );
  assert.equal(
    shouldRebuildCachedRunnerArtifact(
      runnerConnectFailure('runner_connect_refused', 'Runner did not accept connection'),
    ),
    true,
  );
  assert.equal(
    shouldRebuildCachedRunnerArtifact(
      runnerConnectFailure(
        'runner_connect_refused',
        'Runner did not accept connection (simctl spawn)',
        {
          port: 8100,
        },
      ),
    ),
    true,
  );
  // Wiping derived data cannot fix a boot that refuses to compile.
  assert.equal(
    shouldRebuildCachedRunnerArtifact(
      runnerConnectFailure(
        'xcodebuild_exited_early',
        'Runner did not accept connection (xcodebuild exited early)',
        { port: 8100, logPath: '/tmp/runner.log' },
      ),
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

test('a refused connection before send restarts the session', () => {
  assert.equal(
    shouldRestartRunnerBeforeCommandSend(
      runnerConnectFailure('runner_connect_refused', 'Runner did not accept connection'),
    ),
    true,
  );
});

test('an early exit or a foreign transport failure earns no restart before send', () => {
  const earlyExit = runnerConnectFailure(
    'xcodebuild_exited_early',
    'xcodebuild exited early: runner did not accept connection',
  );
  assert.equal(shouldRestartRunnerBeforeCommandSend(earlyExit), false);
  assert.equal(shouldRestartRunnerBeforeCommandSend(commandFailed('socket hang up')), false);
});

// --- typed connect-failure reasons (agent-device's own connect path) ---

test('xcodebuild_exited_early is decided by the typed reason, not the message', () => {
  for (const message of ['Runner did not accept connection (xcodebuild exited early)', 'boom']) {
    const error = runnerConnectFailure('xcodebuild_exited_early', message);
    assert.equal(isRetryableRunnerError(error), false, message);
    assert.equal(shouldRetryRunnerConnectError(error), false, message);
    assert.equal(shouldRebuildCachedRunnerArtifact(error), false, message);
    assert.equal(shouldRestartRunnerBeforeCommandSend(error), false, message);
  }
  // The same words without the reason earn no terminal verdict.
  const untyped = commandFailed('Runner did not accept connection (xcodebuild exited early)');
  assert.equal(shouldRetryRunnerConnectError(untyped), true);
});

test('runner_connect_refused is decided by the typed reason, not the message', () => {
  for (const message of ['Runner did not accept connection', 'boom']) {
    const error = runnerConnectFailure('runner_connect_refused', message);
    assert.equal(isRetryableRunnerError(error), true, message);
    assert.equal(shouldRetryRunnerConnectError(error), true, message);
    assert.equal(shouldRebuildCachedRunnerArtifact(error), true, message);
    assert.equal(shouldRestartRunnerBeforeCommandSend(error), true, message);
  }
  const untyped = commandFailed('Runner did not accept connection');
  assert.equal(isRetryableRunnerError(untyped), false);
  assert.equal(shouldRebuildCachedRunnerArtifact(untyped), false);
  assert.equal(shouldRestartRunnerBeforeCommandSend(untyped), false);
});

test('runner_endpoint_probe_exhausted is decided by the typed reason, not the message', () => {
  for (const message of ['Runner endpoint probe failed', 'boom']) {
    const error = runnerConnectFailure('runner_endpoint_probe_exhausted', message);
    assert.equal(shouldRebuildCachedRunnerArtifact(error), true, message);
    assert.equal(isRetryableRunnerError(error), false, message);
    assert.equal(shouldRestartRunnerBeforeCommandSend(error), false, message);
    assert.equal(shouldRetryRunnerConnectError(error), true, message);
  }
  assert.equal(
    shouldRebuildCachedRunnerArtifact(commandFailed('Runner endpoint probe failed')),
    false,
  );
});

// The literals are what the Swift runner encodes, so they are the contract and not the constant
// names: a rename on one side has to fail here rather than silently split the pair (#2728).
test('a refused screen capture keeps the runner reason and stays off the wire code', () => {
  assert.deepEqual([...RUNNER_SCREEN_CAPTURE_REFUSAL_RUNNER_CODES].sort(), [
    'APP_SCREEN_CAPTURE_UNRENDERABLE',
    'APP_SCREEN_UNRESOLVED',
    'APP_SCREEN_WINDOW_UNRESOLVED',
  ]);
  for (const runnerCode of RUNNER_SCREEN_CAPTURE_REFUSAL_RUNNER_CODES) {
    const classified = classifyRunnerReportedError(runnerCode);
    assert.equal(classified.code, 'COMMAND_FAILED');
    assert.equal(classified.details.runnerErrorCode, runnerCode);
    assert.equal(classified.details.retriable, undefined);
  }
});

// --- busy refusal (isRunnerBusyError) ---

test('only the typed RUNNER_BUSY refusal reads as busy', () => {
  assert.equal(
    isRunnerBusyError(commandFailed('runner is busy', { runnerErrorCode: 'RUNNER_BUSY' })),
    true,
  );
  // The stalling command's own timeout already spent its wait: not a refusal to resend.
  assert.equal(
    isRunnerBusyError(
      commandFailed('main thread execution timed out', { runnerErrorCode: 'MAIN_THREAD_TIMEOUT' }),
    ),
    false,
  );
  assert.equal(
    isRunnerBusyError(
      commandFailed('The iOS runner is still finishing a previous command', { retriable: true }),
    ),
    false,
  );
  assert.equal(isRunnerBusyError(commandFailed('RUNNER_BUSY')), false);
  assert.equal(isRunnerBusyError(new Error('RUNNER_BUSY')), false);
});
