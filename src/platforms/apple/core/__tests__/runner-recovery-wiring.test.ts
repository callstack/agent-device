import assert from 'node:assert/strict';
import { afterEach, expect, test, vi } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import { IOS_SIMULATOR } from '../../../../__tests__/test-utils/device-fixtures.ts';
import type { ExecResult } from '../../../../utils/exec.ts';
import type { RunnerSession } from '../runner/runner-session.ts';
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

const ensureRunnerSessionMock = vi.hoisted(() => vi.fn());

vi.mock('../runner/runner-session.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../runner/runner-session.ts')>();
  return {
    ...actual,
    // Session creation only. executeRunnerCommandWithSession stays REAL, so
    // the send → classify → recover path under test is production code.
    ensureRunnerSession: ensureRunnerSessionMock,
  };
});

const { runAppleRunnerCommand } = await import('../runner/runner-client.ts');

afterEach(async () => {
  await server?.close();
  server = undefined;
  ensureRunnerSessionMock.mockReset();
});

function seedSession(port: number): RunnerSession {
  const session: RunnerSession = {
    sessionId: `wiring:${port}`,
    device: IOS_SIMULATOR,
    deviceId: IOS_SIMULATOR.id,
    port,
    xctestrunPath: '/tmp/wiring.xctestrun',
    jsonPath: '/tmp/wiring.json',
    testPromise: new Promise<ExecResult>(() => {}),
    child: { pid: process.pid, exitCode: null },
    ready: true,
  };
  ensureRunnerSessionMock.mockResolvedValue(session);
  return session;
}

test('a lost transport response is recovered through the production command path', async () => {
  // 1st request: the tap, answered by dropping the connection mid-response
  // (the real "lost response" shape). 2nd: the status probe recovery issues.
  server = await startFakeRunnerServer({
    // The tap's response is dropped mid-flight (the real "lost response"
    // shape); the status probe recovery issues then returns the retained one.
    tap: [{ kind: 'hangUp' }],
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

  const result = await runAppleRunnerCommand(IOS_SIMULATOR, { command: 'tap', x: 5, y: 5 });

  // The recovered payload proves the whole chain ran: classification said
  // retryable, the callsite invoked recovery, recovery probed status, and the
  // retained response replaced the lost one.
  assert.deepEqual(result, { recovered: true });
  const tap = server.requests.find((request) => request.command === 'tap');
  const status = server.requests.find((request) => request.command === 'status');
  assert.ok(tap, 'the tap reached the runner');
  assert.ok(status, 'recovery probed status');
  // The probe must reference the exact command id the send assigned.
  assert.equal(typeof tap.body.commandId, 'string');
  assert.equal(status.body.statusCommandId, tap.body.commandId);
});

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
