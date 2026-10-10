import assert from 'node:assert/strict';
import type { ExecResult } from '@agent-device/host-kit/command';
import { createRequestCanceledError, isRequestCanceledError } from '@agent-device/kernel/errors';
import { withKeyedLock } from '@agent-device/kernel/keyed-lock';
import { afterEach, test, vi } from 'vitest';

const { mockSendRunnerCommandOnce } = vi.hoisted(() => ({ mockSendRunnerCommandOnce: vi.fn() }));

vi.mock('../runner-transport.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../runner-transport.ts')>();
  mockSendRunnerCommandOnce.mockImplementation(actual.sendRunnerCommandOnce);
  return { ...actual, sendRunnerCommandOnce: mockSendRunnerCommandOnce };
});

import { executeRunnerExchange } from '../runner-exchange.ts';
import { RunnerCommandAccounting, type RunnerSession } from '../runner-session-types.ts';
import { IOS_SIMULATOR } from './device-fixtures.ts';
import {
  startFakeRunnerServer,
  type FakeRunnerResponse,
  type FakeRunnerServer,
} from './fake-runner-server.ts';

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

const LONG_PRESS = {
  command: 'longPress',
  x: 10,
  y: 10,
  durationMs: 5_000,
  appBundleId: 'com.example.app',
} as const;

function journalState(lifecycleState: string): FakeRunnerResponse {
  return { kind: 'ok', data: { lifecycleState } };
}

async function abortOnceReceived(
  runner: FakeRunnerServer,
  command: string,
  controller: AbortController,
  reason: unknown = createRequestCanceledError(),
): Promise<void> {
  const giveUpAtMs = Date.now() + 2_000;
  while (!runner.requests.some((request) => request.command === command)) {
    if (Date.now() >= giveUpAtMs) {
      throw new Error(`The fake runner never received "${command}"; nothing to abort.`);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
  controller.abort(reason);
}

function statusPolls(runner: FakeRunnerServer): unknown[] {
  return runner.requests
    .filter((request) => request.command === 'status')
    .map((request) => request.body.statusCommandId);
}

function sentCommandId(runner: FakeRunnerServer, command: string): unknown {
  return runner.requests.find((request) => request.command === command)?.body.commandId;
}

test('a canceled exchange whose command reached the runner settles only once its journal entry is terminal', async () => {
  server = await startFakeRunnerServer({
    longPress: [{ kind: 'hold' }],
    status: [journalState('started'), journalState('completed')],
  });
  const runner = server;
  const session = sessionFor(runner.port);
  const controller = new AbortController();
  let requestsWhenSettled = -1;

  const exchange = executeRunnerExchange(
    IOS_SIMULATOR,
    session,
    LONG_PRESS,
    undefined,
    10_000,
    async () => {},
    controller.signal,
  ).finally(() => {
    requestsWhenSettled = runner.requests.length;
  });
  await abortOnceReceived(runner, 'longPress', controller);

  await assert.rejects(exchange, isRequestCanceledError);
  const commandId = sentCommandId(runner, 'longPress');
  assert.deepEqual(statusPolls(runner), [commandId, commandId]);
  assert.equal(requestsWhenSettled, runner.requests.length);
  assert.equal(session.commandCharges.hasOutstandingCharges, false);
});

test('a request on the same session lock starts only after the canceled command is terminal', async () => {
  server = await startFakeRunnerServer({
    longPress: [{ kind: 'hold' }],
    status: [journalState('accepted'), journalState('started'), journalState('failed')],
  });
  const runner = server;
  const session = sessionFor(runner.port);
  const locks = new Map<string, Promise<unknown>>();
  const controller = new AbortController();

  const canceled = withKeyedLock(locks, 'session:default', async () => {
    await executeRunnerExchange(
      IOS_SIMULATOR,
      session,
      LONG_PRESS,
      undefined,
      10_000,
      async () => {},
      controller.signal,
    );
  });
  await abortOnceReceived(runner, 'longPress', controller);
  const nextRequestSawPolls = withKeyedLock(locks, 'session:default', async () =>
    statusPolls(runner),
  );

  await assert.rejects(canceled, isRequestCanceledError);
  assert.equal((await nextRequestSawPolls).length, 3);
  assert.equal(session.commandCharges.hasOutstandingCharges, false);
});

test('a request canceled before its command is sent releases without reading the journal', async () => {
  server = await startFakeRunnerServer({});
  const session = sessionFor(server.port);
  session.lastHealthyMutation = { atMs: Date.now(), appBundleId: LONG_PRESS.appBundleId };
  const controller = new AbortController();
  controller.abort(createRequestCanceledError());

  await assert.rejects(
    executeRunnerExchange(
      IOS_SIMULATOR,
      session,
      LONG_PRESS,
      undefined,
      10_000,
      async () => {},
      controller.signal,
    ),
    isRequestCanceledError,
  );

  assert.deepEqual(server.requests, []);
  assert.equal(session.commandCharges.hasOutstandingCharges, false);
});

test('a cancellation the transport proves unsent withdraws the charge without reading the journal', async () => {
  server = await startFakeRunnerServer({ status: [journalState('started')] });
  const session = sessionFor(server.port);
  session.lastHealthyMutation = { atMs: Date.now(), appBundleId: LONG_PRESS.appBundleId };
  const controller = new AbortController();
  mockSendRunnerCommandOnce.mockImplementationOnce(async () => {
    controller.abort(createRequestCanceledError());
    throw createRequestCanceledError({ dispatched: 'no' });
  });

  await assert.rejects(
    executeRunnerExchange(
      IOS_SIMULATOR,
      session,
      LONG_PRESS,
      undefined,
      10_000,
      async () => {},
      controller.signal,
    ),
    isRequestCanceledError,
  );

  assert.deepEqual(server.requests, []);
  assert.equal(session.commandCharges.hasOutstandingCharges, false);
});

test('a canceled command the journal never accepted releases after one read and stays abandoned', async () => {
  server = await startFakeRunnerServer({
    longPress: [{ kind: 'hold' }],
    status: [journalState('notAccepted')],
  });
  const session = sessionFor(server.port);
  const controller = new AbortController();

  const exchange = executeRunnerExchange(
    IOS_SIMULATOR,
    session,
    LONG_PRESS,
    undefined,
    10_000,
    async () => {},
    controller.signal,
  );
  await abortOnceReceived(server, 'longPress', controller);

  await assert.rejects(exchange, isRequestCanceledError);
  assert.equal(statusPolls(server).length, 1);
  assert.equal(session.commandCharges.hasAbandonedCharges, true);
});

test('a drain that outlives the command deadline settles and leaves the charge abandoned', async () => {
  server = await startFakeRunnerServer({
    longPress: [{ kind: 'hold' }],
    status: Array.from({ length: 50 }, () => journalState('started')),
  });
  const session = sessionFor(server.port);
  const controller = new AbortController();
  const timeoutMs = 300;
  const startedAtMs = Date.now();

  const exchange = executeRunnerExchange(
    IOS_SIMULATOR,
    session,
    LONG_PRESS,
    undefined,
    timeoutMs,
    async () => {},
    controller.signal,
  );
  await abortOnceReceived(server, 'longPress', controller);

  await assert.rejects(exchange, isRequestCanceledError);
  assert.ok(statusPolls(server).length >= 1);
  assert.ok(Date.now() - startedAtMs < timeoutMs + 1_000);
  assert.equal(session.commandCharges.hasAbandonedCharges, true);
});

test("a caller's own deadline abort does not wait on the runner journal", async () => {
  server = await startFakeRunnerServer({
    longPress: [{ kind: 'hold' }],
    status: [journalState('started'), journalState('completed')],
  });
  const session = sessionFor(server.port);
  const controller = new AbortController();

  const exchange = executeRunnerExchange(
    IOS_SIMULATOR,
    session,
    LONG_PRESS,
    undefined,
    10_000,
    async () => {},
    controller.signal,
  );
  await abortOnceReceived(
    server,
    'longPress',
    controller,
    new DOMException('Wait deadline exceeded', 'TimeoutError'),
  );

  await assert.rejects(exchange);
  assert.deepEqual(statusPolls(server), []);
  assert.equal(session.commandCharges.hasAbandonedCharges, true);
});
