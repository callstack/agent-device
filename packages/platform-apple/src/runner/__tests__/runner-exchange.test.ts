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

test('the readiness probe preserves its main-thread busy report when the command omits it', async () => {
  server = await startFakeRunnerServer({
    uptime: [{ kind: 'ok', data: { runnerMainThreadBusy: true } }],
    tap: [{ kind: 'ok', data: { tapped: true } }],
  });
  const session = sessionFor(server.port);

  await executeRunnerExchange(
    IOS_SIMULATOR,
    session,
    { command: 'tap', x: 10, y: 10, appBundleId: 'com.example.app' },
    undefined,
    10_000,
    async () => {},
  );

  assert.equal(session.runnerMainThreadBusy, true);
});

test.each(['activate', 'terminate', 'targetReset'] as const)(
  'a starting runner sends exempt %s without a readiness preflight',
  async (command) => {
    server = await startFakeRunnerServer([{ kind: 'ok', data: {} }]);
    const session = sessionFor(server.port);
    session.state = 'starting';

    await executeRunnerExchange(
      IOS_SIMULATOR,
      session,
      { command, appBundleId: 'com.example.app' },
      undefined,
      10_000,
      async () => {},
    );

    assert.deepEqual(
      server.requests.map((request) => request.command),
      [command],
    );
  },
);

test('the exchange awaits owner invalidation before returning a fatal answer', async () => {
  server = await startFakeRunnerServer({
    snapshot: [{ kind: 'ok', data: { runnerFatal: true, runnerFatalReason: 'ax_failed' } }],
  });
  const session = sessionFor(server.port);
  session.lastHealthyMutation = { atMs: Date.now(), appBundleId: 'com.example.app' };
  let signalInvalidationStarted!: () => void;
  const invalidationStarted = new Promise<void>((resolve) => {
    signalInvalidationStarted = resolve;
  });
  let releaseInvalidation!: () => void;
  const invalidationGate = new Promise<void>((resolve) => {
    releaseInvalidation = resolve;
  });
  let settled = false;

  const exchange = executeRunnerExchange(
    IOS_SIMULATOR,
    session,
    { command: 'snapshot', appBundleId: 'com.example.app' },
    undefined,
    10_000,
    async (reason) => {
      assert.equal(reason, 'ax_failed');
      signalInvalidationStarted();
      await invalidationGate;
    },
  ).finally(() => {
    settled = true;
  });

  try {
    await invalidationStarted;
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(settled, false);
  } finally {
    releaseInvalidation();
  }
  const result = await exchange;

  assert.equal(result.runnerFatal, true);
  assert.equal(session.lastHealthyMutation, undefined);
  assert.equal(session.commandCharges.hasOutstandingCharges, false);
});

test('the exchange awaits owner invalidation before throwing a fatal runner error', async () => {
  server = await startFakeRunnerServer({
    snapshot: [{ kind: 'runnerError', code: 'RUNNER_WEDGED', message: 'runner wedged' }],
  });
  const session = sessionFor(server.port);
  let signalInvalidationStarted!: () => void;
  const invalidationStarted = new Promise<void>((resolve) => {
    signalInvalidationStarted = resolve;
  });
  let releaseInvalidation!: () => void;
  const invalidationGate = new Promise<void>((resolve) => {
    releaseInvalidation = resolve;
  });
  let settled = false;

  const exchange = executeRunnerExchange(
    IOS_SIMULATOR,
    session,
    { command: 'snapshot', appBundleId: 'com.example.app' },
    undefined,
    10_000,
    async (reason) => {
      assert.equal(reason, 'runner_main_thread_wedged');
      signalInvalidationStarted();
      await invalidationGate;
    },
  ).finally(() => {
    settled = true;
  });
  void exchange.catch(() => {});

  try {
    await invalidationStarted;
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(settled, false);
  } finally {
    releaseInvalidation();
  }
  await assert.rejects(exchange);
});
