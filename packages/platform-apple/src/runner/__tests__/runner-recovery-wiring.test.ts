import assert from 'node:assert/strict';
import { afterEach, expect, test, vi } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import { IOS_SIMULATOR } from './device-fixtures.ts';
import type { ExecResult } from '../host.ts';
import type { RunnerSession } from '../runner-session.ts';
import { startFakeRunnerServer, type FakeRunnerServer } from './fake-runner-server.ts';

/**
 * The wiring regression the recovery suite cannot provide (#1644 review P1):
 * that suite calls `handleRunnerTransportErrorAfterCommandSend` directly, so
 * deleting the shipped callsite in `runner-lifecycle.ts` leaves it green.
 *
 * This enters at `runAppleRunnerCommand` — the production facade and the
 * AppleRunnerProvider seam — and fakes only session CREATION, the xcodebuild
 * spawn no unit test can perform. Real: command-id assignment, provider
 * resolution, `executeRunnerCommand`'s catch/classification, the recovery
 * callsite, the whole recovery module, `executeRunnerCommandWithSession`,
 * the transport fetch, and response parsing. Removing the
 * `isRetryableRunnerError` branch that routes into recovery turns this red
 * (verified by doing exactly that).
 *
 * Entering one layer lower (`executeRunnerCommand`) silently defeats the
 * test: the command id is assigned by the facade, and recovery declines to
 * probe a command without one.
 */

let server: FakeRunnerServer | undefined;

const { ensureRunnerSessionMock, invalidateRunnerSessionMock } = vi.hoisted(() => ({
  ensureRunnerSessionMock: vi.fn(),
  invalidateRunnerSessionMock: vi.fn(async () => {}),
}));

vi.mock('../runner-session.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../runner-session.ts')>();
  return {
    ...actual,
    // Session creation only. executeRunnerCommandWithSession stays REAL, so
    // the send → classify → recover path under test is production code.
    ensureRunnerSession: ensureRunnerSessionMock,
    invalidateRunnerSession: invalidateRunnerSessionMock,
  };
});

const { runAppleRunnerCommand } = await import('../runner-client.ts');

type LostResponseAcceptanceCommand = 'press' | 'fill';

const LOST_RESPONSE_MUTATION_ROWS = {
  press: {
    acceptanceCommand: 'press',
    runnerCommand: 'tap',
    request: { command: 'tap', x: 5, y: 5 },
  },
  fill: {
    acceptanceCommand: 'fill',
    runnerCommand: 'type',
    request: { command: 'type', text: 'hello', textEntryMode: 'replace' },
  },
} as const satisfies Record<
  LostResponseAcceptanceCommand,
  Readonly<{
    acceptanceCommand: LostResponseAcceptanceCommand;
    runnerCommand: 'tap' | 'type';
    request: Readonly<Record<string, unknown>>;
  }>
>;

afterEach(async () => {
  await server?.close();
  server = undefined;
  ensureRunnerSessionMock.mockReset();
  invalidateRunnerSessionMock.mockReset();
});

function makeRunnerSession(port: number, sessionId = `wiring:${port}`): RunnerSession {
  const session: RunnerSession = {
    sessionId,
    device: IOS_SIMULATOR,
    deviceId: IOS_SIMULATOR.id,
    port,
    xctestrunPath: '/tmp/wiring.xctestrun',
    jsonPath: '/tmp/wiring.json',
    testPromise: new Promise<ExecResult>(() => {}),
    child: { pid: process.pid, exitCode: null },
    ready: true,
  };
  return session;
}

function seedSession(port: number): RunnerSession {
  const session = makeRunnerSession(port);
  ensureRunnerSessionMock.mockResolvedValue(session);
  return session;
}

test.each(Object.values(LOST_RESPONSE_MUTATION_ROWS))(
  'acceptance row: lost-response-after-mutation for $acceptanceCommand does not replay the mutation',
  async ({ runnerCommand, request }) => {
    // 1st request: the mutation, answered by dropping the connection
    // mid-response (the real "lost response" shape). 2nd: the status probe.
    server = await startFakeRunnerServer({
      // The mutation's response is dropped mid-flight (the real "lost
      // response" shape); the status probe then returns the retained one.
      [runnerCommand]: [{ kind: 'hangUp' }],
      status: [
        {
          kind: 'ok',
          data: {
            lifecycleState: 'completed',
            lifecycleResponseJson: JSON.stringify({ ok: true, data: { recovered: true } }),
          },
        },
      ],
    });
    seedSession(server.port);

    const result = await runAppleRunnerCommand(IOS_SIMULATOR, { ...request });

    // The recovered payload proves the whole chain ran: classification said
    // retryable, the callsite invoked recovery, recovery probed status, and
    // the retained response replaced the lost one.
    assert.deepEqual(result, { recovered: true });
    const mutation = server.requests.find((entry) => entry.command === runnerCommand);
    const status = server.requests.find((entry) => entry.command === 'status');
    assert.ok(mutation, `${runnerCommand} reached the runner`);
    assert.ok(status, 'recovery probed status');
    // The probe must reference the exact command id the send assigned.
    assert.equal(typeof mutation.body.commandId, 'string');
    assert.equal(status.body.statusCommandId, mutation.body.commandId);
    assert.equal(
      server.requests.filter((entry) => entry.command === runnerCommand).length,
      1,
      `${runnerCommand} must not be silently replayed after the response is lost`,
    );
  },
);

test('a runner that reports the command failed surfaces that failure, not the transport error', async () => {
  server = await startFakeRunnerServer({
    tap: [{ kind: 'hangUp' }],
    status: [
      { kind: 'ok', data: { lifecycleState: 'failed', lifecycleErrorMessage: 'tap missed' } },
    ],
  });
  seedSession(server.port);

  await expect(
    runAppleRunnerCommand(IOS_SIMULATOR, { command: 'tap', x: 5, y: 5 }),
  ).rejects.toThrow(AppError);
  assert.ok(server.requests.some((request) => request.command === 'status'));
});

test('an unrecoverable lifecycle state still reaches recovery and reports the invalidation', async () => {
  server = await startFakeRunnerServer({
    tap: [{ kind: 'hangUp' }],
    status: [{ kind: 'ok', data: { lifecycleState: 'zombie' } }],
  });
  seedSession(server.port);

  await expect(
    runAppleRunnerCommand(IOS_SIMULATOR, { command: 'tap', x: 5, y: 5 }),
  ).rejects.toThrow(/invalidated the runner session/);
  assert.ok(server.requests.some((request) => request.command === 'status'));
});

test('a failed restart preserves the invalidated runner evidence', async () => {
  const restartedServer = await startFakeRunnerServer({
    tap: [{ kind: 'hangUp' }],
    status: [{ kind: 'ok', data: { lifecycleState: 'zombie' } }],
  });
  try {
    server = await startFakeRunnerServer({
      uptime: [{ kind: 'runnerError', code: 'COMMAND_FAILED', message: 'fetch failed' }],
    });
    const staleSession = makeRunnerSession(server.port, 'session-stale');
    const restartedSession = makeRunnerSession(restartedServer.port, 'session-restarted');
    ensureRunnerSessionMock
      .mockResolvedValueOnce(staleSession)
      .mockResolvedValueOnce(restartedSession);

    await expect(
      runAppleRunnerCommand(
        IOS_SIMULATOR,
        { command: 'tap', x: 5, y: 5 },
        { logPath: '/tmp/restart.ndjson' },
      ),
    ).rejects.toMatchObject({
      details: {
        runnerRestarted: true,
        runnerRestartReason: 'runner_readiness_preflight_failed_before_command_send',
        runnerRestartCommand: 'tap',
        runnerInvalidatedSessionId: staleSession.sessionId,
        runnerRestartSessionId: restartedSession.sessionId,
        logPath: '/tmp/restart.ndjson',
      },
    });
  } finally {
    await restartedServer.close();
  }
});

test('an exact-session command never dispatches to a replacement runner', async () => {
  server = await startFakeRunnerServer({ recordStop: [{ kind: 'ok', data: {} }] });
  const replacement = seedSession(server.port);

  await expect(
    runAppleRunnerCommand(
      IOS_SIMULATOR,
      { command: 'recordStop' },
      { expectedRunnerSessionId: `${replacement.sessionId}:replaced` },
    ),
  ).rejects.toThrow('runner session ownership changed');
  assert.deepEqual(server.requests, []);
});
