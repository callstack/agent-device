import assert from 'node:assert/strict';
import { afterEach, test, vi } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import { IOS_SIMULATOR } from './device-fixtures.ts';
import type { ExecResult } from '../host.ts';
import { handleRunnerTransportErrorAfterCommandSend } from '../runner-command-recovery.ts';
import type { RunnerCommand } from '../runner-contract.ts';
import type { RunnerSession } from '../runner-session.ts';
import {
  startFakeRunnerServer,
  type FakeRunnerResponse,
  type FakeRunnerServer,
} from './fake-runner-server.ts';

// Recovery driven through the REAL stack: real executeRunnerCommandWithSession,
// real transport fetch, a scripted fake runner on localhost, and the
// invalidateSession parameter the module already exposes as its seam. The only
// faked thing is the runner process itself (#1631).

let server: FakeRunnerServer | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
});

function makeRunnerSession(port: number): RunnerSession {
  return {
    sessionId: `fake:${port}`,
    device: IOS_SIMULATOR,
    deviceId: IOS_SIMULATOR.id,
    port,
    xctestrunPath: '/tmp/fake.xctestrun',
    jsonPath: '/tmp/fake.json',
    testPromise: new Promise<ExecResult>(() => {}),
    child: { pid: process.pid, exitCode: null },
    ready: true,
  };
}

function tapCommand(commandId = 'cmd-1'): RunnerCommand {
  return { command: 'tap', x: 10, y: 10, commandId } as RunnerCommand;
}

async function runRecovery(params: {
  script: FakeRunnerResponse[];
  command?: RunnerCommand;
  transportError?: AppError;
}): Promise<{
  result: Promise<Record<string, unknown>>;
  session: RunnerSession;
  invalidate: ReturnType<typeof vi.fn>;
  transportError: AppError;
}> {
  server = await startFakeRunnerServer(params.script);
  const session = makeRunnerSession(server.port);
  const invalidate = vi.fn(async () => {});
  const transportError = params.transportError ?? new AppError('COMMAND_FAILED', 'socket hang up');
  const result = handleRunnerTransportErrorAfterCommandSend({
    device: IOS_SIMULATOR,
    session,
    command: params.command ?? tapCommand(),
    transportError,
    options: {},
    signal: undefined,
    invalidationReason: 'transport_error_after_command_send',
    invalidateSession: invalidate,
  });
  return { result, session, invalidate, transportError };
}

test('a completed command with a retained response recovers without invalidation', async () => {
  const { result, invalidate } = await runRecovery({
    script: [
      {
        kind: 'ok',
        data: {
          lifecycleState: 'completed',
          lifecycleResponseJson: JSON.stringify({ ok: true, data: { tapped: true } }),
        },
      },
    ],
  });

  assert.deepEqual(await result, { tapped: true });
  assert.equal(invalidate.mock.calls.length, 0);
  assert.equal(server?.requests[0]?.command, 'status');
  assert.equal(server?.requests[0]?.body.statusCommandId, 'cmd-1');
});

test('a runner-reported failure surfaces without invalidating the session', async () => {
  const { result, invalidate } = await runRecovery({
    script: [
      { kind: 'ok', data: { lifecycleState: 'failed', lifecycleErrorMessage: 'tap failed' } },
    ],
  });

  await assert.rejects(result, (error: unknown) => error instanceof AppError);
  assert.equal(invalidate.mock.calls.length, 0);
});

test('a command still in flight surfaces without invalidating the session', async () => {
  const { result, invalidate } = await runRecovery({
    script: [{ kind: 'ok', data: { lifecycleState: 'started' } }],
  });

  await assert.rejects(result, (error: unknown) => error instanceof AppError);
  assert.equal(invalidate.mock.calls.length, 0);
});

test('an unknown lifecycle state invalidates the session and says so', async () => {
  const { result, invalidate } = await runRecovery({
    script: [{ kind: 'ok', data: { lifecycleState: 'zombie' } }],
  });

  await assert.rejects(result, (error: unknown) => {
    return error instanceof AppError && error.message.includes('invalidated the runner session');
  });
  assert.equal(invalidate.mock.calls.length, 1);
  assert.equal(invalidate.mock.calls[0]?.[1], 'transport_error_after_command_send');
});

test('a failing status probe retains the invalidation and rethrows the transport error', async () => {
  const { result, invalidate, transportError } = await runRecovery({
    script: [{ kind: 'runnerError', code: 'COMMAND_FAILED', message: 'status probe exploded' }],
  });

  await assert.rejects(result, (error: unknown) => error === transportError);
  assert.equal(invalidate.mock.calls.length, 1);
});

test('a command without an id cannot be probed: invalidate and rethrow', async () => {
  const { result, invalidate, transportError } = await runRecovery({
    script: [],
    command: { command: 'tap', x: 10, y: 10 } as RunnerCommand,
  });

  await assert.rejects(result, (error: unknown) => error === transportError);
  assert.equal(invalidate.mock.calls.length, 1);
  assert.equal(server?.requests.length, 0);
});

test('a completed read-only command without a retained response rethrows without invalidation', async () => {
  const { result, invalidate, transportError } = await runRecovery({
    script: [{ kind: 'ok', data: { lifecycleState: 'completed' } }],
    command: { command: 'snapshot', commandId: 'cmd-ro' } as RunnerCommand,
  });

  await assert.rejects(result, (error: unknown) => error === transportError);
  assert.equal(invalidate.mock.calls.length, 0);
});
