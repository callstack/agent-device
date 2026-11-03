import assert from 'node:assert/strict';
import { beforeEach, test, vi } from 'vitest';
import {
  AppError,
  createRequestCanceledError,
  isRequestCanceledError,
} from '@agent-device/kernel/errors';
import { appleRunnerTestHost } from '../test-host.ts';
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

import { prepareIosRunner, runAppleRunnerCommand } from '../index.ts';
import { resetRunnerRecycleLedgerForTests } from '../runner-recycle-ledger.ts';
import { executeRunnerCommand, prepareLocalIosRunner } from '../runner-lifecycle.ts';
import { executeRunnerExchange } from '../runner-exchange.ts';
import { startFakeRunnerServer } from './fake-runner-server.ts';
import type { RunnerCommand } from '../runner-contract.ts';

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
    runnerConnectFailure(
      'xcodebuild_exited_early',
      'Runner did not accept connection (xcodebuild exited early)',
    ),
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

for (const status of [502, 503, 504]) {
  for (const operation of ['mutation preflight', 'cold read', 'preparation'] as const) {
    test(`forwarding ${status} exhaustion retains the run during ${operation}`, async () => {
      const preflight = operation === 'mutation preflight';
      const server = await startFakeRunnerServer({
        uptime: [{ kind: 'httpErrorAlways', status }],
        snapshot: [{ kind: 'httpErrorAlways', status }],
      });
      try {
        const session = makeRunnerSession({
          port: server.port,
          state: preflight ? 'ready' : 'starting',
          endpoint: {
            port: server.port,
            token: 'runner-token',
            http: { url: `http://127.0.0.1:${server.port}/command`, headers: {} },
          },
        });
        const ensure = mockEnsureRunnerSession.mockResolvedValue(session);
        const invalidate = mockInvalidateRunnerSession.mockResolvedValue(undefined);
        mockReadRunnerSessionLiveness.mockReturnValue({
          sessionId: session.sessionId,
          liveness: session.state,
        });
        mockExecuteRunnerCommandWithSession.mockImplementation(
          (device, target, command, logPath, timeoutMs, signal) =>
            executeRunnerExchange(
              device,
              target,
              command,
              logPath,
              Math.min(timeoutMs, 100),
              async (reason) => invalidate(target, reason),
              signal,
            ),
        );
        const execute = executeRunnerCommand;
        const command: RunnerCommand = preflight
          ? { command: 'tap', x: 10, y: 20 }
          : { command: 'snapshot' };
        const pending =
          operation === 'preparation'
            ? prepareLocalIosRunner(IOS_SIMULATOR, { healthTimeoutMs: 100 })
            : execute(IOS_SIMULATOR, command, {});
        await assert.rejects(pending, (error: unknown) => {
          assert.ok(error instanceof AppError);
          assert.equal(error.details?.reason, 'runner_forwarding_unavailable');
          assert.equal(error.details?.status, status);
          assert.equal(error.details?.dispatched, preflight ? 'no' : 'unknown');
          assert.equal(error.details?.runnerConnectFailureReason, undefined);
          return true;
        });
        assert.equal(ensure.mock.calls.length, 1);
        assert.equal(invalidate.mock.calls.length, 0);
        assert.ok(server.requests.length > 0);
        const sentCommand = operation === 'cold read' ? 'snapshot' : 'uptime';
        assert.ok(server.requests.every((request) => request.command === sentCommand));
      } finally {
        await server.close();
      }
    });
  }
}

test.each([false, true])(
  'a forwarding outage retains the replacement runner after a real connection failure, preflight=%s',
  async (preflight) => {
    const oldServer = await startFakeRunnerServer([{ kind: 'exit' }]);
    const replacement = await startFakeRunnerServer({
      uptime: [{ kind: 'httpErrorAlways', status: 502 }],
      snapshot: [{ kind: 'httpErrorAlways', status: 502 }],
    });
    try {
      const sessions = [oldServer, replacement].map((server) =>
        makeRunnerSession({
          port: server.port,
          state: preflight ? 'ready' : 'starting',
          endpoint: {
            port: server.port,
            token: 'runner-token',
            http: { url: `http://127.0.0.1:${server.port}/command` },
          },
        }),
      );
      const ensure = mockEnsureRunnerSession
        .mockResolvedValueOnce(sessions[0])
        .mockResolvedValue(sessions[1]);
      const invalidate = mockInvalidateRunnerSession.mockResolvedValue(undefined);
      mockReadRunnerSessionLiveness.mockReturnValue({
        sessionId: sessions[0]!.sessionId,
        liveness: sessions[0]!.state,
      });
      mockExecuteRunnerCommandWithSession.mockImplementation(
        (device, session, command, logPath, timeoutMs, signal) =>
          executeRunnerExchange(
            device,
            session,
            command,
            logPath,
            Math.min(timeoutMs, 100),
            async (reason) => invalidate(session, reason),
            signal,
          ),
      );
      const execute = executeRunnerCommand;
      await assert.rejects(
        execute(
          IOS_SIMULATOR,
          preflight ? { command: 'tap', x: 10, y: 20 } : { command: 'snapshot' },
          {},
        ),
        (error: unknown) => {
          assert.ok(error instanceof AppError);
          assert.equal(error.details?.reason, 'runner_forwarding_unavailable');
          assert.equal(error.details?.dispatched, preflight ? 'no' : 'unknown');
          assert.equal(error.details?.runnerRestarted, true);
          return true;
        },
      );
      assert.equal(ensure.mock.calls.length, 2);
      assert.equal(invalidate.mock.calls.length, 1);
      assert.equal(invalidate.mock.calls[0]![0], sessions[0]);
      assert.ok(replacement.requests.length > 0);
      assert.ok(
        replacement.requests.every(
          (request) => request.command === (preflight ? 'uptime' : 'snapshot'),
        ),
      );
    } finally {
      await oldServer.close();
      await replacement.close();
    }
  },
);
