import assert from 'node:assert/strict';
import type { ExecResult } from '@agent-device/host-kit/command';
import { afterEach, test } from 'vitest';
import { executeRunnerExchange } from '../runner-exchange.ts';
import { RunnerCommandAccounting, type RunnerSession } from '../runner-session-types.ts';
import { IOS_SIMULATOR } from './device-fixtures.ts';
import { startFakeRunnerServer, type FakeRunnerServer } from './fake-runner-server.ts';

let server: FakeRunnerServer | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
});

function sessionFor(port: number): RunnerSession {
  return {
    sessionId: `exchange:${port}`,
    device: IOS_SIMULATOR,
    deviceId: IOS_SIMULATOR.id,
    port,
    xctestrunPath: '/tmp/fake.xctestrun',
    jsonPath: '/tmp/fake.json',
    testPromise: new Promise<ExecResult>(() => {}),
    child: { pid: process.pid, exitCode: null },
    state: 'ready',
    commandCharges: new RunnerCommandAccounting(),
  };
}

test('the exchange preflights a mutation and settles only its answer', async () => {
  server = await startFakeRunnerServer({
    uptime: [{ kind: 'ok', data: { uptimeMs: 5 } }],
    tap: [{ kind: 'ok', data: { tapped: true } }],
  });
  const session = sessionFor(server.port);
  const invalidations: string[] = [];

  const result = await executeRunnerExchange(
    IOS_SIMULATOR,
    session,
    { command: 'tap', x: 10, y: 10, appBundleId: 'com.example.app' },
    undefined,
    10_000,
    async (reason) => {
      invalidations.push(reason);
    },
  );

  assert.deepEqual(result, { tapped: true });
  assert.deepEqual(
    server.requests.map(({ command }) => command),
    ['uptime', 'tap'],
  );
  assert.equal(session.commandCharges.hasOutstandingCharges, false);
  assert.equal(session.lastHealthyMutation?.appBundleId, 'com.example.app');
  assert.deepEqual(invalidations, []);
});

test('the exchange awaits owner invalidation before returning a fatal answer', async () => {
  server = await startFakeRunnerServer({
    snapshot: [{ kind: 'ok', data: { runnerFatal: true, runnerFatalReason: 'ax_failed' } }],
  });
  const session = sessionFor(server.port);
  session.lastHealthyMutation = { atMs: Date.now(), appBundleId: 'com.example.app' };
  const order: string[] = [];

  const result = await executeRunnerExchange(
    IOS_SIMULATOR,
    session,
    { command: 'snapshot', appBundleId: 'com.example.app' },
    undefined,
    10_000,
    async (reason) => {
      await Promise.resolve();
      order.push(reason);
    },
  );
  order.push('returned');

  assert.equal(result.runnerFatal, true);
  assert.deepEqual(order, ['ax_failed', 'returned']);
  assert.equal(session.lastHealthyMutation, undefined);
  assert.equal(session.commandCharges.hasOutstandingCharges, false);
});
