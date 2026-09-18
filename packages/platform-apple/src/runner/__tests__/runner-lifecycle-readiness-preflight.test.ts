import assert from 'node:assert/strict';
import { beforeEach, test, vi } from 'vitest';
import {
  AppError,
  createRequestCanceledError,
  isRequestCanceledError,
} from '@agent-device/kernel/errors';
import { appleRunnerTestHost } from '../test-host.ts';
import type { RunnerXctestrunArtifact } from '../runner-xctestrun.ts';
import { IOS_SIMULATOR } from './device-fixtures.ts';
import { createTestRequestCancellation, makeRunnerSession } from './runner-session-fixtures.ts';

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

import { prepareIosRunner, runAppleRunnerCommand } from '../runner-client.ts';
import { resetRunnerRecycleLedgerForTests } from '../runner-recycle-ledger.ts';

// What `executeRunnerCommand` decides when a readiness preflight refuses the runner
// before the command was ever written: the table's own verdict axes say whether the
// session restarts, whether the restored artifact is suspect, and whether the caller
// simply hears the refusal.

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

test('mutating commands restart stale sessions when readiness preflight fails before command send', async () => {
  const staleSession = makeRunnerSession({ port: 8100, state: 'ready' });
  const freshSession = makeRunnerSession({ port: 8101, state: 'starting' });

  mockEnsureRunnerSession.mockResolvedValueOnce(staleSession).mockResolvedValueOnce(freshSession);
  mockExecuteRunnerCommandWithSession
    .mockRejectedValueOnce(
      new AppError('COMMAND_FAILED', 'fetch failed', {
        runnerReadinessPreflightFailed: true,
      }),
    )
    .mockResolvedValueOnce({ message: 'tapped' });

  const result = await runAppleRunnerCommand(IOS_SIMULATOR, { command: 'tap', x: 120, y: 240 });

  assert.deepEqual(result, { message: 'tapped' });
  assert.equal(mockEnsureRunnerSession.mock.calls.length, 2);
  assert.deepEqual(mockInvalidateRunnerSession.mock.calls[0], [
    staleSession,
    'runner_readiness_preflight_failed_before_command_send',
  ]);
  assert.equal(mockExecuteRunnerCommandWithSession.mock.calls.length, 2);
  assert.equal(mockExecuteRunnerCommandWithSession.mock.calls[1]?.[1], freshSession);
});

test('a readiness preflight that runs out a post deadline restarts the session and replays', async () => {
  const staleSession = makeRunnerSession({ port: 8100, state: 'ready' });
  const freshSession = makeRunnerSession({ port: 8101, state: 'starting' });

  // The simulator and usbmux routes post to the runner themselves, and `fetchWithTimeout` reports
  // an expiry as "Runner command deadline exceeded" with the budget it ran out. Neither of the two
  // message checks this rule replaced matched that wording, so the command was never replayed.
  // What routes it is the marker the preflight catch puts on its way out, not the wording.
  mockEnsureRunnerSession.mockResolvedValueOnce(staleSession).mockResolvedValueOnce(freshSession);
  mockExecuteRunnerCommandWithSession
    .mockRejectedValueOnce(
      new AppError('COMMAND_FAILED', 'Runner command deadline exceeded', {
        port: 8100,
        timeoutMs: 45_000,
        runnerReadinessPreflightFailed: true,
      }),
    )
    .mockResolvedValueOnce({ message: 'tapped' });

  const result = await runAppleRunnerCommand(IOS_SIMULATOR, { command: 'tap', x: 120, y: 240 });

  assert.deepEqual(result, { message: 'tapped' });
  assert.equal(mockEnsureRunnerSession.mock.calls.length, 2);
  assert.equal(mockExecuteRunnerCommandWithSession.mock.calls[1]?.[1], freshSession);
});

test('a readiness preflight refusal restarts the session like any other preflight failure', async () => {
  const staleSession = makeRunnerSession({ port: 8100, state: 'ready' });
  const freshSession = makeRunnerSession({ port: 8101, state: 'starting' });

  // This is the shape no message check could have been written for: the runner answered the probe
  // and the answer was no, which says nothing about whether the command was written. The marker
  // says that, and it says it for every shape at once.
  mockEnsureRunnerSession.mockResolvedValueOnce(staleSession).mockResolvedValueOnce(freshSession);
  mockExecuteRunnerCommandWithSession
    .mockRejectedValueOnce(
      new AppError('COMMAND_FAILED', 'Runner readiness refused', {
        runnerReadinessPreflightFailed: true,
      }),
    )
    .mockResolvedValueOnce({ message: 'tapped' });

  const result = await runAppleRunnerCommand(IOS_SIMULATOR, { command: 'tap', x: 120, y: 240 });

  assert.deepEqual(result, { message: 'tapped' });
  assert.deepEqual(mockInvalidateRunnerSession.mock.calls[0], [
    staleSession,
    'runner_readiness_preflight_failed_before_command_send',
  ]);
});

test('a failed readiness probe without the marker does not restart the session', async () => {
  const session = makeRunnerSession({ port: 8100, state: 'ready' });

  // Without the marker the failure is just a transport shape, and the one that says the command
  // was never written is the reason this restart is safe at all.
  mockEnsureRunnerSession.mockResolvedValueOnce(session);
  mockExecuteRunnerCommandWithSession.mockRejectedValueOnce(
    new AppError('COMMAND_FAILED', 'Runner readiness refused'),
  );

  await assert.rejects(
    () => runAppleRunnerCommand(IOS_SIMULATOR, { command: 'tap', x: 120, y: 240 }),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.message, 'Runner readiness refused');
      return true;
    },
  );
  assert.equal(mockEnsureRunnerSession.mock.calls.length, 1);
});

test('a cancellation during the readiness preflight does not restart the session it canceled', async () => {
  const session = makeRunnerSession({ port: 8100, state: 'ready' });

  // The preflight's catch marks whatever it was waiting on when it gave up, and one of the things
  // it waits on is a caller that stopped waiting. That mark describes a walkaway, not a wedged
  // runner, and a session that is ready is the one the caller just left: restarting it would boot a
  // runner for a command nobody is going to send again, and take down a session that still works.
  mockEnsureRunnerSession.mockResolvedValueOnce(session);
  mockExecuteRunnerCommandWithSession.mockRejectedValueOnce(
    createRequestCanceledError({ runnerReadinessPreflightFailed: true, command: 'tap' }),
  );

  await assert.rejects(
    () => runAppleRunnerCommand(IOS_SIMULATOR, { command: 'tap', x: 120, y: 240 }),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.ok(isRequestCanceledError(error));
      return true;
    },
  );
  assert.equal(mockInvalidateRunnerSession.mock.calls.length, 0);
  assert.equal(mockEnsureRunnerSession.mock.calls.length, 1);
  assert.equal(mockExecuteRunnerCommandWithSession.mock.calls.length, 1);
});

test('a boot that exited early does not wipe a restored runner artifact', async () => {
  const restoredSession = makeRunnerSession({
    port: 8100,
    xctestrunPath: '/tmp/restored.xctestrun',
    xctestrunArtifact: makeRunnerArtifact({ xctestrunPath: '/tmp/restored.xctestrun' }),
  });

  mockEnsureRunnerSession.mockResolvedValueOnce(restoredSession);
  mockExecuteRunnerCommandWithSession.mockRejectedValueOnce(
    new AppError('COMMAND_FAILED', 'Runner did not accept connection (xcodebuild exited early)'),
  );

  await assert.rejects(
    () => prepareIosRunner(IOS_SIMULATOR, { healthTimeoutMs: 90_000 }),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.message, 'Runner did not accept connection (xcodebuild exited early)');
      return true;
    },
  );
  assert.equal(mockMarkRunnerXctestrunArtifactBadForRun.mock.calls.length, 0);
  assert.equal(mockEnsureRunnerSession.mock.calls.length, 1);
});
