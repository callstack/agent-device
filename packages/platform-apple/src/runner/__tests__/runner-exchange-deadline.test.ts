import assert from 'node:assert/strict';
import { AppError } from '@agent-device/kernel/errors';
import { afterEach, beforeEach, test, vi } from 'vitest';

/** A controlled clock: the readiness preflight spends `preflightMs` of it when it answers. */
const clock = vi.hoisted(() => ({ offsetMs: 0, preflightMs: 0 }));

vi.mock('../runner-startup-transport.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../runner-startup-transport.ts')>();
  return {
    ...actual,
    waitForRunner: async (...args: Parameters<typeof actual.waitForRunner>) => {
      const response = await actual.waitForRunner(...args);
      if (args[2].command === 'uptime') clock.offsetMs += clock.preflightMs;
      return response;
    },
  };
});

import { executeRunnerExchange } from '../runner-exchange.ts';
import type { RunnerCommand } from '../runner-contract.ts';
import { IOS_SIMULATOR } from './device-fixtures.ts';
import { makeRunnerSession } from './runner-session-fixtures.ts';
import { startFakeRunnerServer, type FakeRunnerServer } from './fake-runner-server.ts';

const NOW_MS = 1_000_000;
let server: FakeRunnerServer | undefined;

beforeEach(() => {
  clock.offsetMs = 0;
  clock.preflightMs = 0;
  vi.spyOn(Date, 'now').mockImplementation(() => NOW_MS + clock.offsetMs);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await server?.close();
  server = undefined;
});

async function exchange(command: RunnerCommand): Promise<unknown> {
  server = await startFakeRunnerServer({ alert: [{ kind: 'ok', data: { handled: true } }] });
  return await executeRunnerExchange(
    IOS_SIMULATOR,
    makeRunnerSession({ port: server.port }),
    command,
    undefined,
    45_000,
    async () => {},
  ).catch((error: unknown) => error);
}

function sentAlerts(): Record<string, unknown>[] {
  return (server?.requests ?? [])
    .filter(({ command }) => command === 'alert')
    .map(({ body }) => body);
}

test('an alert command whose deadline already passed is refused unsent', async () => {
  const outcome = await exchange({
    command: 'alert',
    action: 'get',
    timeoutMs: 10_000,
    deadline: { atMs: NOW_MS - 1, minTimeoutMs: 1 },
  });

  assert.ok(outcome instanceof AppError);
  assert.equal(outcome.details?.reason, 'runner_command_deadline_spent');
  assert.equal(outcome.details?.dispatched, 'no');
  assert.deepEqual(sentAlerts(), []);
});

test('a press the preflight leaves too little time for is not sent', async () => {
  clock.preflightMs = 800;
  const outcome = await exchange({
    command: 'alert',
    action: 'accept',
    timeoutMs: 10_000,
    deadline: { atMs: NOW_MS + 10_500, minTimeoutMs: 10_000 },
  });

  assert.ok(outcome instanceof AppError);
  assert.equal(outcome.details?.reason, 'runner_command_deadline_spent');
  assert.equal(outcome.details?.dispatched, 'no');
  assert.deepEqual(sentAlerts(), []);
});

test('the runner timeout is what the deadline leaves after the preflight', async () => {
  clock.preflightMs = 800;
  const outcome = await exchange({
    command: 'alert',
    action: 'get',
    timeoutMs: 10_000,
    deadline: { atMs: NOW_MS + 5_000, minTimeoutMs: 1 },
  });

  assert.deepEqual(outcome, { handled: true });
  assert.equal(sentAlerts().length, 1);
  assert.equal(sentAlerts()[0]?.timeoutMs, 4_200);
  assert.equal('deadline' in (sentAlerts()[0] ?? {}), false, 'the deadline stays on the host');
});

test.each([
  ['exactly the shortest timeout it needs is sent', 10_000, true],
  ['1 ms below the shortest timeout it needs is refused unsent', 9_999, false],
] as const)('a press left %s', async (_case, leftMs, sent) => {
  const outcome = await exchange({
    command: 'alert',
    action: 'accept',
    timeoutMs: 10_000,
    deadline: { atMs: NOW_MS + leftMs, minTimeoutMs: 10_000 },
  });

  if (sent) {
    assert.deepEqual(outcome, { handled: true });
    assert.equal(sentAlerts()[0]?.timeoutMs, 10_000);
  } else {
    assert.ok(outcome instanceof AppError);
    assert.equal(outcome.details?.reason, 'runner_command_deadline_spent');
    assert.equal(outcome.details?.dispatched, 'no');
    assert.deepEqual(sentAlerts(), []);
  }
});
