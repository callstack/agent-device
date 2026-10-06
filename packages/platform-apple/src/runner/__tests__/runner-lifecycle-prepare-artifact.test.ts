import assert from 'node:assert/strict';
import { beforeEach, test, vi } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import { appleRunnerTestHost } from '../test-host.ts';
import { Deadline } from '../host.ts';
import { IOS_SIMULATOR } from './device-fixtures.ts';
import {
  makeRunnerArtifact,
  createTestRequestCancellation,
  makeRunnerSession,
  runnerConnectFailure,
} from './runner-session-fixtures.ts';

const {
  mockEnsureRunnerSession,
  mockExecuteRunnerCommandWithSession,
  mockEmitDiagnostic,
  mockReadRunnerSessionLiveness,
  mockInvalidateRunnerSession,
  mockMarkRunnerXctestrunArtifactBadForRun,
} = vi.hoisted(() => ({
  mockEnsureRunnerSession: vi.fn(),
  mockExecuteRunnerCommandWithSession: vi.fn(),
  mockEmitDiagnostic: vi.fn(),
  mockReadRunnerSessionLiveness: vi.fn(),
  mockInvalidateRunnerSession: vi.fn(),
  mockMarkRunnerXctestrunArtifactBadForRun: vi.fn(),
}));

vi.mock('../runner-session.ts', async () => {
  const actual =
    await vi.importActual<typeof import('../runner-session.ts')>('../runner-session.ts');
  return {
    ...actual,
    ensureRunnerSession: mockEnsureRunnerSession,
    executeRunnerCommandWithSession: mockExecuteRunnerCommandWithSession,
    readRunnerSessionLiveness: mockReadRunnerSessionLiveness,
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

import { prepareIosRunner } from '../runner-client.ts';
import { resetRunnerRecycleLedgerForTests } from '../runner-recycle-ledger.ts';

const requestCancellation = createTestRequestCancellation();
const { isRequestCanceled } = requestCancellation;

beforeEach(() => {
  vi.resetAllMocks();
  resetRunnerRecycleLedgerForTests();
  mockReadRunnerSessionLiveness.mockReturnValue(null);
  mockMarkRunnerXctestrunArtifactBadForRun.mockResolvedValue(undefined);
  requestCancellation.reset();
  appleRunnerTestHost.update({
    emitDiagnostic: mockEmitDiagnostic,
    isRequestCanceled,
    getRequestSignal: () => undefined,
  });
});

// What a spent prepare deadline does to a restored artifact. Prepare spends one `Deadline` across
// boot and health check, so the failure this decision actually sees is the one
// `readPreparePhaseTimeoutMs` raises when the boot ate the budget: "prepare ios-runner timed out"
// with reason `prepare_deadline_expired`. That indicts the boot, not the derived data it was
// launched from, so the artifact stays and prepare retries with a fresh session. The artifact is
// only wiped by the rules that indict it, such as a runner that refused the connection.

test('a prepare deadline spent during boot keeps the restored artifact and retries', async () => {
  vi.useFakeTimers();
  try {
    vi.setSystemTime(1_000);
    const restoredSession = makeRunnerSession({
      port: 8100,
      xctestrunPath: '/tmp/restored.xctestrun',
      xctestrunArtifact: makeRunnerArtifact({ xctestrunPath: '/tmp/restored.xctestrun' }),
    });
    const prepareDeadline = Deadline.fromTimeoutMs(45_000);

    mockEnsureRunnerSession.mockImplementation(async () => {
      // The boot consumed the whole prepare budget, so no health phase time remains.
      vi.setSystemTime(46_000);
      return restoredSession;
    });

    await assert.rejects(
      () => prepareIosRunner(IOS_SIMULATOR, { healthTimeoutMs: 90_000, prepareDeadline }),
      (error: unknown) => {
        assert.ok(error instanceof AppError);
        assert.equal(error.message, 'prepare ios-runner timed out');
        assert.equal(error.details?.reason, 'prepare_deadline_expired');
        assert.equal(error.details?.phase, 'runner_session');
        return true;
      },
    );

    assert.equal(mockMarkRunnerXctestrunArtifactBadForRun.mock.calls.length, 0);
    assert.deepEqual(mockInvalidateRunnerSession.mock.calls.at(-1), [
      restoredSession,
      'prepare_runner_health_retry',
    ]);
  } finally {
    vi.useRealTimers();
  }
});

// The bad-cache recovery decision: a restored artifact whose runner refuses the connection is
// indicted, wiped for the run, and replaced by one forced rebuild — under one admission token
// owned by the prepare loop, so the rebuild is the retry a fence governs rather than a fresh
// start that slips past it (#3220).

test('prepareIosRunner marks a bad restored artifact and rebuilds once after health failure', async () => {
  const fixtures = makeBadCacheRecoveryFixtures();

  mockEnsureRunnerSession
    .mockResolvedValueOnce(fixtures.restoredSession)
    .mockResolvedValueOnce(fixtures.rebuiltSession);
  mockExecuteRunnerCommandWithSession
    .mockRejectedValueOnce(runnerConnectFailure('runner_connect_refused'))
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
    cache: 'exact',
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
    .mockRejectedValueOnce(runnerConnectFailure('runner_endpoint_probe_exhausted'))
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
  const firstCallOptions = mockEnsureRunnerSession.mock.calls[0]?.[1] as
    | { startAdmission?: unknown }
    | undefined;
  const retryOptions = mockEnsureRunnerSession.mock.calls[1]?.[1] as
    | Record<string, unknown>
    | undefined;
  assert.deepEqual(retryOptions, {
    healthTimeoutMs: 90_000,
    buildTimeoutMs: 300_000,
    cleanStaleBundles: true,
    forceRunnerXctestrunRebuild: true,
    startAdmission: firstCallOptions?.startAdmission,
  });
  // Both attempts of the prepare loop share one admission token: the retry
  // is the replacement build for the first attempt, not a newcomer.
  assert.ok(firstCallOptions?.startAdmission);
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
  assert.deepEqual(prepareDiagnostic.data?.timingContainment, {
    connectMs: ['buildMs'],
    healthCheckMs: [],
  });
}
