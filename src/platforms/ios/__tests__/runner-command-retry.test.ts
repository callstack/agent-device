import { beforeEach, test, vi } from 'vitest';
import assert from 'node:assert/strict';
import { IOS_SIMULATOR } from '../../../__tests__/test-utils/index.ts';
import { clearRequestCanceled, markRequestCanceled } from '../../../daemon/request-cancel.ts';
import { AppError } from '../../../kernel/errors.ts';
import type { RunnerSession } from '../runner-session-types.ts';

const {
  mockEnsureRunnerSession,
  mockExecuteRunnerCommandWithSession,
  mockEmitDiagnostic,
  mockInvalidateRunnerSession,
  mockMarkRunnerXctestrunArtifactBadForRun,
} = vi.hoisted(() => ({
  mockEnsureRunnerSession: vi.fn(),
  mockExecuteRunnerCommandWithSession: vi.fn(),
  mockEmitDiagnostic: vi.fn(),
  mockInvalidateRunnerSession: vi.fn(),
  mockMarkRunnerXctestrunArtifactBadForRun: vi.fn(),
}));

vi.mock('../../../utils/diagnostics.ts', async () => {
  const actual = await vi.importActual<typeof import('../../../utils/diagnostics.ts')>(
    '../../../utils/diagnostics.ts',
  );
  return {
    ...actual,
    emitDiagnostic: mockEmitDiagnostic,
  };
});

vi.mock('../runner-session.ts', async () => {
  const actual =
    await vi.importActual<typeof import('../runner-session.ts')>('../runner-session.ts');
  return {
    ...actual,
    ensureRunnerSession: mockEnsureRunnerSession,
    executeRunnerCommandWithSession: mockExecuteRunnerCommandWithSession,
    invalidateRunnerSession: mockInvalidateRunnerSession,
  };
});

vi.mock('../runner-xctestrun.ts', async () => {
  const actual =
    await vi.importActual<typeof import('../runner-xctestrun.ts')>('../runner-xctestrun.ts');
  return {
    ...actual,
    markRunnerXctestrunArtifactBadForRun: mockMarkRunnerXctestrunArtifactBadForRun,
  };
});

import {
  prepareIosRunner,
  prewarmIosRunnerSession,
  runIosRunnerCommand,
} from '../runner-client.ts';
import type { RunnerXctestrunArtifact } from '../runner-xctestrun.ts';

beforeEach(() => {
  vi.resetAllMocks();
  mockMarkRunnerXctestrunArtifactBadForRun.mockResolvedValue(undefined);
});

test('prepareIosRunner marks a bad restored artifact and rebuilds once after health failure', async () => {
  const fixtures = makeBadCacheRecoveryFixtures();

  mockEnsureRunnerSession
    .mockResolvedValueOnce(fixtures.restoredSession)
    .mockResolvedValueOnce(fixtures.rebuiltSession);
  mockExecuteRunnerCommandWithSession
    .mockRejectedValueOnce(new AppError('COMMAND_FAILED', 'Runner did not accept connection'))
    .mockResolvedValueOnce({ uptimeMs: 42 });

  const result = await prepareIosRunner(IOS_SIMULATOR, {
    healthTimeoutMs: 90_000,
    buildTimeoutMs: 300_000,
  });

  assertRecoveredPrepareResult(result);
  assertBadCacheRecoverySideEffects(fixtures);
  assertRecoveredPrepareDiagnostics();
});

test('prepareIosRunner invalidates rebuilt sessions when bad-cache recovery health fails', async () => {
  const restoredArtifact = makeRunnerArtifact({
    xctestrunPath: '/tmp/restored.xctestrun',
    cache: 'restore-key',
    artifact: 'valid',
  });
  const rebuiltArtifact = makeRunnerArtifact({
    xctestrunPath: '/tmp/rebuilt.xctestrun',
    cache: 'miss',
    artifact: 'rebuilt',
  });
  const restoredSession = makeRunnerSession({
    port: 8100,
    xctestrunPath: restoredArtifact.xctestrunPath,
    xctestrunArtifact: restoredArtifact,
  });
  const rebuiltSession = makeRunnerSession({
    port: 8101,
    xctestrunPath: rebuiltArtifact.xctestrunPath,
    xctestrunArtifact: rebuiltArtifact,
  });

  mockEnsureRunnerSession
    .mockResolvedValueOnce(restoredSession)
    .mockResolvedValueOnce(rebuiltSession);
  mockExecuteRunnerCommandWithSession
    .mockRejectedValueOnce(new AppError('COMMAND_FAILED', 'Runner endpoint probe failed'))
    .mockRejectedValueOnce(new AppError('COMMAND_FAILED', 'Runner health timed out'));

  await assert.rejects(
    () => prepareIosRunner(IOS_SIMULATOR, { healthTimeoutMs: 90_000 }),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.message, 'artifact restored but runner did not connect');
      assert.equal(error.details?.restoredFailureReason, 'Runner endpoint probe failed');
      assert.equal(error.details?.xctestrunPath, '/tmp/rebuilt.xctestrun');
      assert.equal(error.details?.artifact, 'rebuilt');
      assert.equal(error.details?.cache, 'miss');
      return true;
    },
  );

  assert.deepEqual(mockInvalidateRunnerSession.mock.calls, [
    [restoredSession, 'prepare_cached_runner_health_failed'],
    [rebuiltSession, 'prepare_rebuilt_runner_health_failed'],
  ]);
  assert.deepEqual(mockMarkRunnerXctestrunArtifactBadForRun.mock.calls[0], [
    restoredArtifact,
    'Runner endpoint probe failed',
  ]);
});

test('prepareIosRunner retries a fresh launch session when the health check cannot connect', async () => {
  const stuckSession = makeRunnerSession({ port: 8100 });
  const relaunchedSession = makeRunnerSession({ port: 8101 });

  mockEnsureRunnerSession
    .mockResolvedValueOnce(stuckSession)
    .mockResolvedValueOnce(relaunchedSession);
  mockExecuteRunnerCommandWithSession
    .mockRejectedValueOnce(new AppError('COMMAND_FAILED', 'Runner did not accept connection'))
    .mockResolvedValueOnce({ uptimeMs: 42 });

  const result = await prepareIosRunner(IOS_SIMULATOR, {
    healthTimeoutMs: 90_000,
    buildTimeoutMs: 300_000,
  });

  assert.deepEqual(result.runner, { uptimeMs: 42 });
  assert.equal(result.recoveryReason, 'Runner did not accept connection');
  assert.equal(mockEnsureRunnerSession.mock.calls[0]?.[1]?.cleanStaleBundles, undefined);
  assert.deepEqual(mockInvalidateRunnerSession.mock.calls, [
    [stuckSession, 'prepare_runner_health_retry'],
  ]);
  assert.equal(mockEnsureRunnerSession.mock.calls.length, 2);
  assert.equal(mockEnsureRunnerSession.mock.calls[1]?.[1]?.cleanStaleBundles, true);
  assert.equal(mockEnsureRunnerSession.mock.calls[1]?.[1]?.forceRunnerXctestrunRebuild, undefined);
  assert.equal(mockExecuteRunnerCommandWithSession.mock.calls[1]?.[1], relaunchedSession);
  assert.deepEqual(
    mockEmitDiagnostic.mock.calls.find(
      ([event]) => event.phase === 'ios_runner_prepare_health_retry',
    )?.[0].data,
    {
      command: 'uptime',
      commandId: mockExecuteRunnerCommandWithSession.mock.calls[0]?.[2].commandId,
      sessionId: stuckSession.sessionId,
      attempt: 1,
      maxAttempts: 2,
      reason: 'Runner did not accept connection',
    },
  );
});

test('prewarmIosRunnerSession proves cached runner health with uptime', async () => {
  const session = makeRunnerSession({ port: 8100 });
  mockEnsureRunnerSession.mockResolvedValueOnce(session);
  mockExecuteRunnerCommandWithSession.mockResolvedValueOnce({ uptimeMs: 42 });

  const prewarm = prewarmIosRunnerSession(IOS_SIMULATOR, {
    buildTimeoutMs: 300_000,
    requestId: 'prewarm-request',
  });

  await prewarm;

  assert.equal(mockEnsureRunnerSession.mock.calls.length, 1);
  assert.equal(mockEnsureRunnerSession.mock.calls[0]?.[1]?.buildTimeoutMs, 300_000);
  assert.equal(mockEnsureRunnerSession.mock.calls[0]?.[1]?.requestId, 'prewarm-request');
  assert.equal(mockEnsureRunnerSession.mock.calls[0]?.[1]?.healthTimeoutMs, 45_000);
  assert.equal(mockExecuteRunnerCommandWithSession.mock.calls.length, 1);
  assert.equal(mockExecuteRunnerCommandWithSession.mock.calls[0]?.[1], session);
  assert.equal(mockExecuteRunnerCommandWithSession.mock.calls[0]?.[2].command, 'uptime');
  assert.equal(mockExecuteRunnerCommandWithSession.mock.calls[0]?.[4], 45_000);
});

test('prewarmIosRunnerSession can propagate setup failures for blocking callers', async () => {
  const failure = new AppError('COMMAND_FAILED', 'Developer mode is disabled');
  mockEnsureRunnerSession.mockRejectedValueOnce(failure);
  const prewarm = prewarmIosRunnerSession(IOS_SIMULATOR, { propagateError: true });

  assert.ok(prewarm);
  await assert.rejects(prewarm, (error: unknown) => error === failure);

  assert.deepEqual(mockEmitDiagnostic.mock.calls[0]?.[0], {
    level: 'warn',
    phase: 'ios_runner_session_prewarm_failed',
    data: {
      deviceId: IOS_SIMULATOR.id,
      error: 'Developer mode is disabled',
    },
  });
  assert.equal(mockEnsureRunnerSession.mock.calls[0]?.[1]?.propagateError, undefined);
});

test('prepareIosRunner does not force a rebuild when the relaunched fresh session still cannot connect', async () => {
  const missArtifact = makeRunnerArtifact({
    xctestrunPath: '/tmp/miss.xctestrun',
    cache: 'miss',
    artifact: 'valid',
  });
  const exactArtifact = makeRunnerArtifact({
    xctestrunPath: '/tmp/exact.xctestrun',
    cache: 'exact',
    artifact: 'valid',
  });
  const stuckSession = makeRunnerSession({
    port: 8100,
    xctestrunPath: missArtifact.xctestrunPath,
    xctestrunArtifact: missArtifact,
  });
  const relaunchedSession = makeRunnerSession({
    port: 8101,
    xctestrunPath: exactArtifact.xctestrunPath,
    xctestrunArtifact: exactArtifact,
  });

  mockEnsureRunnerSession
    .mockResolvedValueOnce(stuckSession)
    .mockResolvedValueOnce(relaunchedSession);
  mockExecuteRunnerCommandWithSession
    .mockRejectedValueOnce(new AppError('COMMAND_FAILED', 'Runner did not accept connection'))
    .mockRejectedValueOnce(new AppError('COMMAND_FAILED', 'Runner did not accept connection'));

  await assert.rejects(
    () =>
      prepareIosRunner(IOS_SIMULATOR, {
        healthTimeoutMs: 90_000,
        forceRunnerXctestrunRebuild: false,
      }),
    /Runner did not accept connection/,
  );

  assert.deepEqual(mockInvalidateRunnerSession.mock.calls, [
    [stuckSession, 'prepare_runner_health_retry'],
    [relaunchedSession, 'prepare_runner_health_failed'],
  ]);
  assert.equal(mockMarkRunnerXctestrunArtifactBadForRun.mock.calls.length, 0);
  assert.equal(mockEnsureRunnerSession.mock.calls.length, 2);
  assert.equal(mockEnsureRunnerSession.mock.calls[0]?.[1]?.cleanStaleBundles, undefined);
  assert.equal(mockEnsureRunnerSession.mock.calls[0]?.[1]?.forceRunnerXctestrunRebuild, false);
  assert.equal(mockEnsureRunnerSession.mock.calls[1]?.[1]?.cleanStaleBundles, true);
  assert.equal(mockEnsureRunnerSession.mock.calls[1]?.[1]?.forceRunnerXctestrunRebuild, false);
});

test('prepareIosRunner does not relaunch after non-retryable runner startup failures', async () => {
  const failedSession = makeRunnerSession({ port: 8100 });

  mockEnsureRunnerSession.mockResolvedValueOnce(failedSession);
  mockExecuteRunnerCommandWithSession.mockRejectedValueOnce(
    new AppError('COMMAND_FAILED', 'xcodebuild exited early'),
  );

  await assert.rejects(
    () => prepareIosRunner(IOS_SIMULATOR, { healthTimeoutMs: 90_000 }),
    /xcodebuild exited early/,
  );

  assert.equal(mockEnsureRunnerSession.mock.calls.length, 1);
  assert.equal(mockInvalidateRunnerSession.mock.calls.length, 0);
  assert.equal(mockMarkRunnerXctestrunArtifactBadForRun.mock.calls.length, 0);
});

test('prepareIosRunner does not relaunch after request cancellation', async () => {
  const requestId = 'prepare-canceled-before-retry';
  const stuckSession = makeRunnerSession({ port: 8100 });

  mockEnsureRunnerSession.mockResolvedValueOnce(stuckSession);
  mockExecuteRunnerCommandWithSession.mockImplementationOnce(() => {
    markRequestCanceled(requestId);
    throw new AppError('COMMAND_FAILED', 'Runner did not accept connection');
  });

  try {
    await assert.rejects(
      () => prepareIosRunner(IOS_SIMULATOR, { healthTimeoutMs: 90_000, requestId }),
      /request canceled/,
    );
  } finally {
    clearRequestCanceled(requestId);
  }

  assert.equal(mockEnsureRunnerSession.mock.calls.length, 1);
  assert.equal(mockInvalidateRunnerSession.mock.calls.length, 0);
});

test('mutating commands restart stale ready sessions when the preflight probe never reaches the runner', async () => {
  const staleSession = makeRunnerSession({ port: 8100, ready: true });
  const freshSession = makeRunnerSession({ port: 8101, ready: false });

  mockEnsureRunnerSession.mockResolvedValueOnce(staleSession).mockResolvedValueOnce(freshSession);
  mockExecuteRunnerCommandWithSession
    .mockRejectedValueOnce(new AppError('COMMAND_FAILED', 'Runner did not accept connection'))
    .mockResolvedValueOnce({ message: 'tapped' });

  const result = await runIosRunnerCommand(IOS_SIMULATOR, { command: 'tap', x: 120, y: 240 });

  assert.deepEqual(result, { message: 'tapped' });
  assert.equal(mockEnsureRunnerSession.mock.calls.length, 2);
  assert.equal(mockEnsureRunnerSession.mock.calls[1]?.[1]?.cleanStaleBundles, true);
  assert.deepEqual(mockInvalidateRunnerSession.mock.calls[0], [
    staleSession,
    'runner_connect_failed_before_command_send',
  ]);
  assert.equal(mockExecuteRunnerCommandWithSession.mock.calls.length, 2);
  assert.equal(mockExecuteRunnerCommandWithSession.mock.calls[0]?.[2].command, 'tap');
  assert.equal(mockExecuteRunnerCommandWithSession.mock.calls[1]?.[1], freshSession);
});

test('mutating commands retry startup sessions with stale bundle cleanup', async () => {
  const startupSession = makeRunnerSession({ port: 8100, ready: false });
  const freshSession = makeRunnerSession({ port: 8101, ready: false });

  mockEnsureRunnerSession.mockResolvedValueOnce(startupSession).mockResolvedValueOnce(freshSession);
  mockExecuteRunnerCommandWithSession
    .mockRejectedValueOnce(new AppError('COMMAND_FAILED', 'Runner did not accept connection'))
    .mockResolvedValueOnce({ message: 'tapped' });

  const result = await runIosRunnerCommand(IOS_SIMULATOR, { command: 'tap', x: 120, y: 240 });

  assert.deepEqual(result, { message: 'tapped' });
  assert.equal(mockEnsureRunnerSession.mock.calls.length, 2);
  assert.equal(mockEnsureRunnerSession.mock.calls[1]?.[1]?.cleanStaleBundles, true);
  assert.deepEqual(mockInvalidateRunnerSession.mock.calls[0], [
    startupSession,
    'runner_connect_failed_before_command_send',
  ]);
  assert.equal(mockExecuteRunnerCommandWithSession.mock.calls.length, 2);
  assert.equal(mockExecuteRunnerCommandWithSession.mock.calls[1]?.[1], freshSession);
});

test('mutating commands restart stale sessions when readiness preflight fails before command send', async () => {
  const staleSession = makeRunnerSession({ port: 8100, ready: true });
  const freshSession = makeRunnerSession({ port: 8101, ready: false });

  mockEnsureRunnerSession.mockResolvedValueOnce(staleSession).mockResolvedValueOnce(freshSession);
  mockExecuteRunnerCommandWithSession
    .mockRejectedValueOnce(
      new AppError('COMMAND_FAILED', 'fetch failed', {
        runnerReadinessPreflightFailed: true,
      }),
    )
    .mockResolvedValueOnce({ message: 'tapped' });

  const result = await runIosRunnerCommand(IOS_SIMULATOR, { command: 'tap', x: 120, y: 240 });

  assert.deepEqual(result, { message: 'tapped' });
  assert.equal(mockEnsureRunnerSession.mock.calls.length, 2);
  assert.deepEqual(mockInvalidateRunnerSession.mock.calls[0], [
    staleSession,
    'runner_readiness_preflight_failed_before_command_send',
  ]);
  assert.equal(mockExecuteRunnerCommandWithSession.mock.calls.length, 2);
  assert.equal(mockExecuteRunnerCommandWithSession.mock.calls[1]?.[1], freshSession);
});

test('mutating commands restart stale sessions when readiness preflight times out before command send', async () => {
  const staleSession = makeRunnerSession({ port: 8100, ready: true });
  const freshSession = makeRunnerSession({ port: 8101, ready: false });

  mockEnsureRunnerSession.mockResolvedValueOnce(staleSession).mockResolvedValueOnce(freshSession);
  mockExecuteRunnerCommandWithSession
    .mockRejectedValueOnce(
      new AppError('COMMAND_FAILED', 'Runner readiness timed out', {
        runnerReadinessPreflightFailed: true,
      }),
    )
    .mockResolvedValueOnce({ message: 'tapped' });

  const result = await runIosRunnerCommand(IOS_SIMULATOR, { command: 'tap', x: 120, y: 240 });

  assert.deepEqual(result, { message: 'tapped' });
  assert.equal(mockEnsureRunnerSession.mock.calls.length, 2);
  assert.deepEqual(mockInvalidateRunnerSession.mock.calls[0], [
    staleSession,
    'runner_readiness_preflight_failed_before_command_send',
  ]);
  assert.equal(mockExecuteRunnerCommandWithSession.mock.calls.length, 2);
  assert.equal(mockExecuteRunnerCommandWithSession.mock.calls[1]?.[1], freshSession);
});

test('mutating commands emit readiness recovery diagnostics after failed preflight restart succeeds', async () => {
  const staleSession = makeRunnerSession({ port: 8100, ready: true });
  const freshSession = makeRunnerSession({ port: 8101, ready: false });

  mockEnsureRunnerSession.mockResolvedValueOnce(staleSession).mockResolvedValueOnce(freshSession);
  mockExecuteRunnerCommandWithSession
    .mockRejectedValueOnce(
      new AppError('COMMAND_FAILED', 'fetch failed', {
        runnerReadinessPreflightFailed: true,
      }),
    )
    .mockResolvedValueOnce({ message: 'tapped' });

  const diagnostics = await captureDiagnostics(async () => {
    const result = await runIosRunnerCommand(IOS_SIMULATOR, { command: 'tap', x: 120, y: 240 });
    assert.deepEqual(result, { message: 'tapped' });
  });

  assert.match(diagnostics, /ios_runner_readiness_preflight_recovered/);
  assert.match(diagnostics, /"recovery":"session_restarted"/);
});

test('mutating commands do not restart or replay after command send failure', async () => {
  const session = makeRunnerSession({ port: 8100, ready: true });

  mockEnsureRunnerSession.mockResolvedValueOnce(session);
  mockExecuteRunnerCommandWithSession
    .mockRejectedValueOnce(new AppError('COMMAND_FAILED', 'fetch failed'))
    .mockResolvedValueOnce({ lifecycleState: 'notAccepted' });

  await assert.rejects(() =>
    runIosRunnerCommand(IOS_SIMULATOR, { command: 'tap', x: 120, y: 240 }),
  );

  assert.equal(mockEnsureRunnerSession.mock.calls.length, 1);
  assert.equal(mockInvalidateRunnerSession.mock.calls.length, 1);
  assert.deepEqual(mockInvalidateRunnerSession.mock.calls[0], [
    session,
    'transport_error_after_command_send',
  ]);
  assert.equal(mockExecuteRunnerCommandWithSession.mock.calls.length, 2);
  assertDiagnosticDecision({
    decision: 'retained',
    reason: 'unknown_lifecycle_state',
    lifecycleState: 'notAccepted',
  });
});

test('mutating commands recover cached responses before invalidating after command send failure', async () => {
  const session = makeRunnerSession({ port: 8100, ready: true });

  mockEnsureRunnerSession.mockResolvedValueOnce(session);
  mockExecuteRunnerCommandWithSession
    .mockRejectedValueOnce(new AppError('COMMAND_FAILED', 'fetch failed'))
    .mockResolvedValueOnce({
      lifecycleState: 'completed',
      lifecycleResponseJson: JSON.stringify({ ok: true, data: { message: 'tapped' } }),
    });

  const result = await runIosRunnerCommand(IOS_SIMULATOR, { command: 'tap', x: 120, y: 240 });

  assert.deepEqual(result, { message: 'tapped' });
  assert.equal(mockInvalidateRunnerSession.mock.calls.length, 0);
  assertDiagnosticDecision({
    decision: 'skipped',
    reason: 'completed_with_retained_response',
    lifecycleState: 'completed',
  });
  assert.equal(mockExecuteRunnerCommandWithSession.mock.calls.length, 2);
  const sentCommand = mockExecuteRunnerCommandWithSession.mock.calls[0]?.[2];
  const statusCommand = mockExecuteRunnerCommandWithSession.mock.calls[1]?.[2];
  assert.equal(statusCommand.command, 'status');
  assert.equal(statusCommand.statusCommandId, sentCommand.commandId);
});

test('mutating commands keep invalidating when status cannot find the command', async () => {
  const session = makeRunnerSession({ port: 8100, ready: true });

  mockEnsureRunnerSession.mockResolvedValueOnce(session);
  mockExecuteRunnerCommandWithSession
    .mockRejectedValueOnce(new AppError('COMMAND_FAILED', 'fetch failed'))
    .mockResolvedValueOnce({
      lifecycleState: 'notAccepted',
    });

  await assert.rejects(() =>
    runIosRunnerCommand(IOS_SIMULATOR, { command: 'tap', x: 120, y: 240 }),
  );

  assert.deepEqual(mockInvalidateRunnerSession.mock.calls, [
    [session, 'transport_error_after_command_send'],
  ]);
  assert.equal(mockExecuteRunnerCommandWithSession.mock.calls.length, 2);
  assertDiagnosticDecision({
    decision: 'retained',
    reason: 'unknown_lifecycle_state',
    lifecycleState: 'notAccepted',
  });
});

test('mutating commands keep invalidating when status recovery probe fails', async () => {
  const session = makeRunnerSession({ port: 8100, ready: true });

  mockEnsureRunnerSession.mockResolvedValueOnce(session);
  mockExecuteRunnerCommandWithSession
    .mockRejectedValueOnce(new AppError('COMMAND_FAILED', 'fetch failed'))
    .mockRejectedValueOnce(new AppError('COMMAND_FAILED', 'status probe failed'));

  await assert.rejects(() =>
    runIosRunnerCommand(IOS_SIMULATOR, { command: 'tap', x: 120, y: 240 }),
  );

  assert.deepEqual(mockInvalidateRunnerSession.mock.calls, [
    [session, 'transport_error_after_command_send'],
  ]);
  assert.equal(mockExecuteRunnerCommandWithSession.mock.calls.length, 2);
  assertDiagnosticDecision({
    decision: 'retained',
    reason: 'status_probe_failed',
  });
});

test('mutating commands keep invalidating when status reports an unknown lifecycle state', async () => {
  const session = makeRunnerSession({ port: 8100, ready: true });

  mockEnsureRunnerSession.mockResolvedValueOnce(session);
  mockExecuteRunnerCommandWithSession
    .mockRejectedValueOnce(new AppError('COMMAND_FAILED', 'fetch failed'))
    .mockResolvedValueOnce({
      lifecycleState: 'paused',
    });

  await assert.rejects(
    () => runIosRunnerCommand(IOS_SIMULATOR, { command: 'tap', x: 120, y: 240 }),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.match(error.message, /lifecycle status was "paused"/);
      assert.equal(error.details?.recovery, 'lifecycle_state_not_recoverable');
      assert.match(String(error.details?.hint), /conservative invalidation path/);
      return true;
    },
  );

  assert.deepEqual(mockInvalidateRunnerSession.mock.calls, [
    [session, 'transport_error_after_command_send'],
  ]);
  assert.equal(mockExecuteRunnerCommandWithSession.mock.calls.length, 2);
  assertDiagnosticDecision({
    decision: 'retained',
    reason: 'unknown_lifecycle_state',
    lifecycleState: 'paused',
  });
});

test('read-only commands retry when completed status has no retained response', async () => {
  const session = makeRunnerSession({ port: 8100, ready: true });

  mockEnsureRunnerSession.mockResolvedValue(session);
  mockExecuteRunnerCommandWithSession
    .mockRejectedValueOnce(new AppError('COMMAND_FAILED', 'fetch failed'))
    .mockResolvedValueOnce({ lifecycleState: 'completed' })
    .mockResolvedValueOnce({ nodes: [], truncated: false });

  const result = await runIosRunnerCommand(IOS_SIMULATOR, { command: 'snapshot' });

  assert.deepEqual(result, { nodes: [], truncated: false });
  assert.equal(mockInvalidateRunnerSession.mock.calls.length, 0);
  assert.equal(mockExecuteRunnerCommandWithSession.mock.calls.length, 3);
  assert.equal(mockExecuteRunnerCommandWithSession.mock.calls[1]?.[2].command, 'status');
  assert.equal(mockExecuteRunnerCommandWithSession.mock.calls[2]?.[2].command, 'snapshot');
  assertDiagnosticDecision({
    decision: 'skipped',
    reason: 'read_only_completed_without_retained_response',
    lifecycleState: 'completed',
  });
});

test('read-only startup commands use the session startup timeout override', async () => {
  const session = makeRunnerSession({
    port: 8100,
    ready: false,
    startupTimeoutMs: 240_000,
  });

  mockEnsureRunnerSession.mockResolvedValue(session);
  mockExecuteRunnerCommandWithSession.mockResolvedValue({ currentUptimeMs: 42 });

  const result = await runIosRunnerCommand(
    IOS_SIMULATOR,
    { command: 'uptime' },
    { startupTimeoutMs: 240_000 },
  );

  assert.deepEqual(result, { currentUptimeMs: 42 });
  assert.equal(mockExecuteRunnerCommandWithSession.mock.calls[0]?.[4], 240_000);
});

test('read-only commands retry when status shows in-flight work', async () => {
  const session = makeRunnerSession({ port: 8100, ready: true });

  mockEnsureRunnerSession.mockResolvedValue(session);
  mockExecuteRunnerCommandWithSession
    .mockRejectedValueOnce(new AppError('COMMAND_FAILED', 'fetch failed'))
    .mockResolvedValueOnce({ lifecycleState: 'started' })
    .mockResolvedValueOnce({ nodes: [], truncated: false });

  const result = await runIosRunnerCommand(IOS_SIMULATOR, { command: 'snapshot' });

  assert.deepEqual(result, { nodes: [], truncated: false });
  assert.equal(mockInvalidateRunnerSession.mock.calls.length, 0);
  assert.equal(mockExecuteRunnerCommandWithSession.mock.calls.length, 3);
  assert.equal(mockExecuteRunnerCommandWithSession.mock.calls[1]?.[2].command, 'status');
  assert.equal(mockExecuteRunnerCommandWithSession.mock.calls[2]?.[2].command, 'snapshot');
});

test('mutating commands report recovery guidance when completed status has no retained response', async () => {
  const session = makeRunnerSession({ port: 8100, ready: true });

  mockEnsureRunnerSession.mockResolvedValueOnce(session);
  mockExecuteRunnerCommandWithSession
    .mockRejectedValueOnce(new AppError('COMMAND_FAILED', 'fetch failed'))
    .mockResolvedValueOnce({ lifecycleState: 'completed' });

  await assert.rejects(
    () => runIosRunnerCommand(IOS_SIMULATOR, { command: 'tap', x: 120, y: 240 }),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.match(error.message, /"tap" completed after the transport response was lost/);
      assert.equal(error.details?.recovery, 'completed_without_retained_response');
      assert.match(String(error.details?.hint), /kept the session open/);
      assert.match(String(error.details?.hint), /will not replay/);
      assert.match(String(error.details?.hint), /snapshot -i/);
      assert.equal(error.details?.transportError, 'fetch failed');
      return true;
    },
  );

  assert.equal(mockInvalidateRunnerSession.mock.calls.length, 0);
  assert.equal(mockExecuteRunnerCommandWithSession.mock.calls.length, 2);
  assertDiagnosticDecision({
    decision: 'skipped',
    reason: 'completed_without_retained_response',
    lifecycleState: 'completed',
  });
});

test('mutating commands run status recovery after transport failure when readiness preflight was skipped', async () => {
  const session = makeRunnerSession({ port: 8100, ready: true });

  mockEnsureRunnerSession.mockResolvedValueOnce(session);
  mockExecuteRunnerCommandWithSession
    .mockRejectedValueOnce(
      new AppError('COMMAND_FAILED', 'fetch failed', {
        runnerReadinessPreflightSkipped: true,
        runnerReadinessPreflightSkipReason: 'recent_healthy_mutation',
        runnerReadinessPreflightSkippedAgeMs: 1_200,
      }),
    )
    .mockResolvedValueOnce({
      lifecycleState: 'completed',
      lifecycleResponseJson: JSON.stringify({ ok: true, data: { message: 'tapped' } }),
    });

  const result = await runIosRunnerCommand(IOS_SIMULATOR, { command: 'tap', x: 120, y: 240 });

  assert.deepEqual(result, { message: 'tapped' });
  assert.equal(mockInvalidateRunnerSession.mock.calls.length, 0);
  assert.equal(mockExecuteRunnerCommandWithSession.mock.calls.length, 2);
  const recoveryDiagnostic = mockEmitDiagnostic.mock.calls.find(
    ([event]) => event.phase === 'ios_runner_command_status_recovery',
  )?.[0];
  assert.ok(recoveryDiagnostic);
  assert.equal(recoveryDiagnostic.data?.readinessPreflightSkipped, true);
  assert.equal(recoveryDiagnostic.data?.readinessPreflightSkipReason, 'recent_healthy_mutation');
  assert.equal(recoveryDiagnostic.data?.readinessPreflightSkippedAgeMs, 1_200);
});

test('mutating commands include skipped readiness context in lost-response guidance', async () => {
  const session = makeRunnerSession({ port: 8100, ready: true });

  mockEnsureRunnerSession.mockResolvedValueOnce(session);
  mockExecuteRunnerCommandWithSession
    .mockRejectedValueOnce(
      new AppError('COMMAND_FAILED', 'fetch failed', {
        runnerReadinessPreflightSkipped: true,
        runnerReadinessPreflightSkipReason: 'recent_healthy_mutation',
        runnerReadinessPreflightSkippedAgeMs: 1_200,
      }),
    )
    .mockResolvedValueOnce({ lifecycleState: 'completed' });

  await assert.rejects(
    () => runIosRunnerCommand(IOS_SIMULATOR, { command: 'tap', x: 120, y: 240 }),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.match(String(error.details?.hint), /^This hot command skipped the uptime preflight/);
      assert.equal(error.details?.readinessPreflightSkipped, true);
      assert.equal(error.details?.readinessPreflightSkipReason, 'recent_healthy_mutation');
      assert.equal(error.details?.readinessPreflightSkippedAgeMs, 1_200);
      return true;
    },
  );

  assert.equal(mockInvalidateRunnerSession.mock.calls.length, 0);
});

test('mutating commands keep conservative invalidation for skipped-preflight failures with unknown lifecycle', async () => {
  const session = makeRunnerSession({ port: 8100, ready: true });

  mockEnsureRunnerSession.mockResolvedValueOnce(session);
  mockExecuteRunnerCommandWithSession
    .mockRejectedValueOnce(
      new AppError('COMMAND_FAILED', 'fetch failed', {
        runnerReadinessPreflightSkipped: true,
        runnerReadinessPreflightSkipReason: 'recent_healthy_mutation',
        runnerReadinessPreflightSkippedAgeMs: 1_200,
      }),
    )
    .mockResolvedValueOnce({ lifecycleState: 'paused' });

  await assert.rejects(() =>
    runIosRunnerCommand(IOS_SIMULATOR, { command: 'tap', x: 120, y: 240 }),
  );

  assert.deepEqual(mockInvalidateRunnerSession.mock.calls, [
    [session, 'transport_error_after_command_send'],
  ]);
  assertDiagnosticDecision({
    decision: 'retained',
    reason: 'unknown_lifecycle_state',
    lifecycleState: 'paused',
  });
});

test('mutating commands preserve runner failure details from status recovery', async () => {
  const session = makeRunnerSession({ port: 8100, ready: true });

  mockEnsureRunnerSession.mockResolvedValueOnce(session);
  mockExecuteRunnerCommandWithSession
    .mockRejectedValueOnce(new AppError('COMMAND_FAILED', 'fetch failed'))
    .mockResolvedValueOnce({
      lifecycleState: 'failed',
      lifecycleErrorCode: 'AMBIGUOUS_MATCH',
      lifecycleErrorMessage: 'Found 2 matching buttons',
      lifecycleErrorHint: 'Use a more specific selector.',
    });

  await assert.rejects(
    () => runIosRunnerCommand(IOS_SIMULATOR, { command: 'tap', x: 120, y: 240 }),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, 'AMBIGUOUS_MATCH');
      assert.equal(error.message, 'Found 2 matching buttons');
      assert.equal(error.details?.recovery, 'runner_reported_failure');
      assert.equal(error.details?.hint, 'Use a more specific selector.');
      assert.equal(error.details?.transportError, 'fetch failed');
      return true;
    },
  );

  assert.equal(mockInvalidateRunnerSession.mock.calls.length, 0);
  assert.equal(mockExecuteRunnerCommandWithSession.mock.calls.length, 2);
  assertDiagnosticDecision({
    decision: 'skipped',
    reason: 'runner_reported_failure',
    lifecycleState: 'failed',
  });
});

test('mutating commands use recovery guidance when failed status has no runner hint', async () => {
  const session = makeRunnerSession({ port: 8100, ready: true });

  mockEnsureRunnerSession.mockResolvedValueOnce(session);
  mockExecuteRunnerCommandWithSession
    .mockRejectedValueOnce(new AppError('COMMAND_FAILED', 'fetch failed'))
    .mockResolvedValueOnce({
      lifecycleState: 'failed',
      lifecycleErrorMessage: 'Runner command failed after dispatch',
    });

  await assert.rejects(
    () => runIosRunnerCommand(IOS_SIMULATOR, { command: 'tap', x: 120, y: 240 }),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.message, 'Runner command failed after dispatch');
      assert.match(String(error.details?.hint), /kept the session open/);
      assert.match(String(error.details?.hint), /did not replay/);
      return true;
    },
  );

  assert.equal(mockInvalidateRunnerSession.mock.calls.length, 0);
  assertDiagnosticDecision({
    decision: 'skipped',
    reason: 'runner_reported_failure',
    lifecycleState: 'failed',
  });
});

test('mutating commands report wait-and-inspect guidance when status shows in-flight work', async () => {
  const session = makeRunnerSession({ port: 8100, ready: true });

  mockEnsureRunnerSession.mockResolvedValueOnce(session);
  mockExecuteRunnerCommandWithSession
    .mockRejectedValueOnce(new AppError('COMMAND_FAILED', 'fetch failed'))
    .mockResolvedValueOnce({ lifecycleState: 'started' });

  await assert.rejects(
    () => runIosRunnerCommand(IOS_SIMULATOR, { command: 'tap', x: 120, y: 240 }),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.match(error.message, /"tap" is still started/);
      assert.equal(error.details?.recovery, 'command_still_in_flight');
      assert.match(String(error.details?.hint), /kept the session open/);
      assert.match(String(error.details?.hint), /snapshot -i/);
      assert.equal(error.details?.transportError, 'fetch failed');
      return true;
    },
  );

  assert.equal(mockInvalidateRunnerSession.mock.calls.length, 0);
  assert.equal(mockExecuteRunnerCommandWithSession.mock.calls.length, 2);
  assertDiagnosticDecision({
    decision: 'skipped',
    reason: 'command_still_in_flight',
    lifecycleState: 'started',
  });
});

test('mutating commands invalidate the retry session without replaying again', async () => {
  const staleSession = makeRunnerSession({ port: 8100, ready: true });
  const freshSession = makeRunnerSession({ port: 8101, ready: false });

  mockEnsureRunnerSession.mockResolvedValueOnce(staleSession).mockResolvedValueOnce(freshSession);
  mockExecuteRunnerCommandWithSession
    .mockRejectedValueOnce(new AppError('COMMAND_FAILED', 'Runner did not accept connection'))
    .mockRejectedValueOnce(new AppError('COMMAND_FAILED', 'fetch failed'))
    .mockResolvedValueOnce({ lifecycleState: 'notAccepted' });

  await assert.rejects(() =>
    runIosRunnerCommand(IOS_SIMULATOR, { command: 'tap', x: 120, y: 240 }),
  );

  assert.equal(mockEnsureRunnerSession.mock.calls.length, 2);
  assert.deepEqual(mockInvalidateRunnerSession.mock.calls, [
    [staleSession, 'runner_connect_failed_before_command_send'],
    [freshSession, 'transport_error_after_retry_command_send'],
  ]);
  assert.equal(mockExecuteRunnerCommandWithSession.mock.calls.length, 3);
  assertDiagnosticDecision({
    decision: 'retained',
    reason: 'unknown_lifecycle_state',
    lifecycleState: 'notAccepted',
  });
});

test('sequence recovers retained per-step results without resending', async () => {
  const session = makeRunnerSession({ port: 8100, ready: true });
  const sequenceData = {
    message: 'sequence',
    completedSteps: 3,
    sequenceResults: [
      { ok: true, kind: 'tap' },
      { ok: true, kind: 'tap' },
      { ok: true, kind: 'tap' },
    ],
  };

  mockEnsureRunnerSession.mockResolvedValueOnce(session);
  mockExecuteRunnerCommandWithSession
    .mockRejectedValueOnce(new AppError('COMMAND_FAILED', 'fetch failed'))
    .mockResolvedValueOnce({
      lifecycleState: 'completed',
      lifecycleResponseJson: JSON.stringify({ ok: true, data: sequenceData }),
    });

  const result = await runIosRunnerCommand(IOS_SIMULATOR, {
    command: 'sequence',
    steps: [
      { kind: 'tap', x: 1, y: 2 },
      { kind: 'tap', x: 3, y: 4 },
      { kind: 'tap', x: 5, y: 6 },
    ],
  });

  assert.deepEqual(result, sequenceData);
  assert.equal(mockInvalidateRunnerSession.mock.calls.length, 0);
  // status probe only — the mutating sequence is never replayed.
  assert.equal(mockExecuteRunnerCommandWithSession.mock.calls.length, 2);
  assert.equal(mockExecuteRunnerCommandWithSession.mock.calls[1]?.[2].command, 'status');
  assertDiagnosticDecision({
    decision: 'skipped',
    reason: 'completed_with_retained_response',
    lifecycleState: 'completed',
  });
});

test('sequence surfaces a lifecycle failure without replaying', async () => {
  const session = makeRunnerSession({ port: 8100, ready: true });

  mockEnsureRunnerSession.mockResolvedValueOnce(session);
  mockExecuteRunnerCommandWithSession
    .mockRejectedValueOnce(new AppError('COMMAND_FAILED', 'fetch failed'))
    .mockResolvedValueOnce({
      lifecycleState: 'failed',
      lifecycleErrorCode: 'UNSUPPORTED_OPERATION',
      lifecycleErrorMessage: 'sequence step 1 (drag) failed',
    });

  await assert.rejects(
    () =>
      runIosRunnerCommand(IOS_SIMULATOR, {
        command: 'sequence',
        steps: [
          { kind: 'tap', x: 1, y: 2 },
          { kind: 'drag', x: 3, y: 4, x2: 5, y2: 6 },
        ],
      }),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, 'UNSUPPORTED_OPERATION');
      assert.equal(error.message, 'sequence step 1 (drag) failed');
      return true;
    },
  );

  assert.equal(mockInvalidateRunnerSession.mock.calls.length, 0);
  assert.equal(mockExecuteRunnerCommandWithSession.mock.calls.length, 2);
  assertDiagnosticDecision({
    decision: 'skipped',
    reason: 'runner_reported_failure',
    lifecycleState: 'failed',
  });
});

test('sequence in-flight after lost response reports no-replay guidance', async () => {
  const session = makeRunnerSession({ port: 8100, ready: true });

  mockEnsureRunnerSession.mockResolvedValueOnce(session);
  mockExecuteRunnerCommandWithSession
    .mockRejectedValueOnce(new AppError('COMMAND_FAILED', 'fetch failed'))
    .mockResolvedValueOnce({ lifecycleState: 'started' });

  await assert.rejects(
    () =>
      runIosRunnerCommand(IOS_SIMULATOR, {
        command: 'sequence',
        steps: [{ kind: 'tap', x: 1, y: 2 }],
      }),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.match(error.message, /"sequence" is still started/);
      assert.match(String(error.details?.hint), /snapshot -i/);
      return true;
    },
  );

  assert.equal(mockInvalidateRunnerSession.mock.calls.length, 0);
  assert.equal(mockExecuteRunnerCommandWithSession.mock.calls.length, 2);
  assertDiagnosticDecision({
    decision: 'skipped',
    reason: 'command_still_in_flight',
    lifecycleState: 'started',
  });
});

test('sequence invalidates the session when the status probe fails', async () => {
  const session = makeRunnerSession({ port: 8100, ready: true });

  mockEnsureRunnerSession.mockResolvedValueOnce(session);
  mockExecuteRunnerCommandWithSession
    .mockRejectedValueOnce(new AppError('COMMAND_FAILED', 'fetch failed'))
    .mockRejectedValueOnce(new AppError('COMMAND_FAILED', 'status probe failed'));

  await assert.rejects(() =>
    runIosRunnerCommand(IOS_SIMULATOR, {
      command: 'sequence',
      steps: [{ kind: 'tap', x: 1, y: 2 }],
    }),
  );

  assert.deepEqual(mockInvalidateRunnerSession.mock.calls, [
    [session, 'transport_error_after_command_send'],
  ]);
  assert.equal(mockExecuteRunnerCommandWithSession.mock.calls.length, 2);
  assertDiagnosticDecision({
    decision: 'retained',
    reason: 'status_probe_failed',
  });
});

function makeBadCacheRecoveryFixtures() {
  const restoredArtifact = makeRunnerArtifact({
    xctestrunPath: '/tmp/restored.xctestrun',
    cache: 'exact',
    artifact: 'valid',
  });
  const rebuiltArtifact = makeRunnerArtifact({
    xctestrunPath: '/tmp/rebuilt.xctestrun',
    cache: 'miss',
    artifact: 'rebuilt',
    buildMs: 123,
  });
  const restoredSession = makeRunnerSession({
    port: 8100,
    xctestrunPath: restoredArtifact.xctestrunPath,
    xctestrunArtifact: restoredArtifact,
  });
  const rebuiltSession = makeRunnerSession({
    port: 8101,
    xctestrunPath: rebuiltArtifact.xctestrunPath,
    xctestrunArtifact: rebuiltArtifact,
  });

  return { restoredArtifact, restoredSession, rebuiltSession };
}

function assertRecoveredPrepareResult(result: Awaited<ReturnType<typeof prepareIosRunner>>): void {
  assert.deepEqual(result, {
    runner: { uptimeMs: 42 },
    cache: 'miss',
    artifact: 'rebuilt',
    buildMs: 123,
    connectMs: result.connectMs,
    healthCheckMs: result.healthCheckMs,
    xctestrunPath: '/tmp/rebuilt.xctestrun',
    recoveryReason: 'Runner did not accept connection',
  });
  assert.equal(result.failureReason, undefined);
  assert.equal(result.connectMs >= 0, true);
  assert.equal(result.healthCheckMs >= 0, true);
}

function assertBadCacheRecoverySideEffects(
  fixtures: ReturnType<typeof makeBadCacheRecoveryFixtures>,
): void {
  assert.deepEqual(mockInvalidateRunnerSession.mock.calls[0], [
    fixtures.restoredSession,
    'prepare_cached_runner_health_failed',
  ]);
  assert.deepEqual(mockMarkRunnerXctestrunArtifactBadForRun.mock.calls[0], [
    fixtures.restoredArtifact,
    'Runner did not accept connection',
  ]);
  assert.deepEqual(mockEnsureRunnerSession.mock.calls[1]?.[1], {
    healthTimeoutMs: 90_000,
    buildTimeoutMs: 300_000,
    cleanStaleBundles: true,
    forceRunnerXctestrunRebuild: true,
  });
  assert.equal(mockExecuteRunnerCommandWithSession.mock.calls.length, 2);
  assert.equal(mockExecuteRunnerCommandWithSession.mock.calls[0]?.[2].command, 'uptime');
  assert.equal(mockExecuteRunnerCommandWithSession.mock.calls[0]?.[4], 90_000);
  assert.equal(mockExecuteRunnerCommandWithSession.mock.calls[1]?.[1], fixtures.rebuiltSession);
}

function assertRecoveredPrepareDiagnostics(): void {
  assert.ok(
    mockEmitDiagnostic.mock.calls.some(
      ([event]) => event.phase === 'ios_runner_prepare_bad_cache_recovered',
    ),
  );
  const prepareDiagnostic = mockEmitDiagnostic.mock.calls.find(
    ([event]) => event.phase === 'apple_runner_prepare',
  )?.[0];
  assert.ok(prepareDiagnostic);
  assert.equal(prepareDiagnostic.level, 'info');
  assert.equal(prepareDiagnostic.data?.cache, 'miss');
  assert.equal(prepareDiagnostic.data?.artifact, 'rebuilt');
  assert.equal(prepareDiagnostic.data?.xctestrunPath, '/tmp/rebuilt.xctestrun');
  assert.equal(prepareDiagnostic.data?.recoveryReason, 'Runner did not accept connection');
  assert.equal(prepareDiagnostic.data?.failureReason, undefined);
}

function assertDiagnosticDecision(expected: {
  decision: 'skipped' | 'retained';
  reason: string;
  lifecycleState?: string;
}): void {
  assert.ok(
    mockEmitDiagnostic.mock.calls.some(([event]) => {
      return (
        event.phase === 'ios_runner_command_invalidation_decision' &&
        event.data?.decision === expected.decision &&
        event.data?.reason === expected.reason &&
        event.data?.lifecycleState === expected.lifecycleState
      );
    }),
    `missing invalidation decision diagnostic ${JSON.stringify(expected)}`,
  );
}

function makeRunnerSession(overrides: Partial<RunnerSession> = {}): RunnerSession {
  return {
    sessionId: `session-${overrides.port ?? 8100}`,
    device: IOS_SIMULATOR,
    deviceId: IOS_SIMULATOR.id,
    port: 8100,
    xctestrunPath: '/tmp/runner.xctestrun',
    jsonPath: '/tmp/runner.json',
    testPromise: Promise.resolve({ exitCode: 0, stdout: '', stderr: '' }),
    child: { pid: 1234, exitCode: null },
    ready: true,
    ...overrides,
  } as RunnerSession;
}

function makeRunnerArtifact(
  overrides: Partial<RunnerXctestrunArtifact> = {},
): RunnerXctestrunArtifact {
  return {
    xctestrunPath: '/tmp/runner.xctestrun',
    derived: '/tmp/derived',
    cache: 'exact',
    artifact: 'valid',
    buildMs: 0,
    xctestrunPathSource: 'manifest',
    ...overrides,
  };
}

async function captureDiagnostics(callback: () => Promise<void>): Promise<string> {
  await callback();
  return JSON.stringify(mockEmitDiagnostic.mock.calls.map(([event]) => event));
}
