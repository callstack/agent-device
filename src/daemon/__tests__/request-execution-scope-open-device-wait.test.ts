import { afterAll, test, expect, vi } from 'vitest';
import fs from 'node:fs';
import type { CommandFlags } from '@agent-device/contracts/command';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { makeSession } from '../../__tests__/test-utils/session-factories.ts';
import { makeSessionStore } from '../../__tests__/test-utils/store-factory.ts';
import { mkdtempForTestSync } from '../../__tests__/test-utils/tmp-dir.ts';
import type { DaemonRequest } from '../daemon-request.ts';
import { LeaseRegistry } from '../lease-registry.ts';
import { readOpenWaitAttempt } from '../open-device-contention-wait.ts';
import { createRequestExecutionScope } from '../request-execution-scope.ts';

// Everything `open --wait <ms>` is for sits between two facts. A waiting open must not hold the
// device execution lock, because `close` — the thing that could free the device — needs that same
// lock. And a waiting open must look at the device again once it owns the lock, because the device
// can be taken in the window between the last look and the lock. These drive two real request
// scopes over one lock map, so both halves are pinned together.

const CONTESTED_DEVICE = vi.hoisted(() => ({
  platform: 'apple',
  id: 'sim-contested',
  name: 'Contested iPhone',
  kind: 'simulator',
  appleOs: 'ios',
  booted: true,
})) as DeviceInfo;

vi.mock('@agent-device/device-selection/dispatch-resolve', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@agent-device/device-selection/dispatch-resolve')>();
  return {
    ...actual,
    resolveTargetDevice: vi.fn(async () => CONTESTED_DEVICE),
  };
});

// The smallest budget the option allows, with room to tell "opened after re-waiting" apart from
// "spent the whole budget and refused" on a wall clock.
const WAIT_BUDGET_MS = 1_000;

const TEST_ROOT = mkdtempForTestSync('agent-device-open-device-wait-');

function openRequest(session: string): DaemonRequest {
  const flags: CommandFlags = { waitMs: WAIT_BUDGET_MS };
  return {
    token: 'token',
    session,
    command: 'open',
    positionals: [],
    flags,
    meta: { cwd: TEST_ROOT, requestId: `req-${session}` },
  };
}

function closeRequest(session: string): DaemonRequest {
  return {
    token: 'token',
    session,
    command: 'close',
    positionals: [],
    meta: { cwd: TEST_ROOT, requestId: `req-${session}-close` },
  };
}

function sessionOnDevice(name: string) {
  return makeSession(name, { device: CONTESTED_DEVICE });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Two opens waiting on one device can both see it free on the same poll. The loser of that race
// still has most of its budget, and the device is reachably its own as soon as the winner hands it
// back, so refusing it where it stands is the bug this pins shut.
test('an open that lost the race to a free device re-waits and opens rather than refusing', async () => {
  const sessionStore = makeSessionStore('agent-device-open-wait-race-');
  const leaseRegistry = new LeaseRegistry();
  sessionStore.set('holder', sessionOnDevice('holder'));
  // The holder lets go shortly after; the first open to bind the device lets go again after that,
  // the way any session closed by its owner would.
  setTimeout(() => sessionStore.delete('holder'), 50);
  setTimeout(() => sessionStore.delete('first-opener'), 400);

  const first = await createRequestExecutionScope({
    req: openRequest('first-opener'),
    sessionStore,
    leaseRegistry,
  });
  const second = await createRequestExecutionScope({
    req: openRequest('second-opener'),
    sessionStore,
    leaseRegistry,
  });

  const order: string[] = [];
  const startedAtMs = Date.now();
  // Each open binds the device to its own session under its own locks, which is what a real open
  // does — the second one can only get in once the first releases it.
  const firstOpened = first.runLocked(async () => {
    sessionStore.set('first-opener', sessionOnDevice('first-opener'));
    order.push('first');
    return 'first-opened';
  });
  const secondOpened = second.runLocked(async () => {
    sessionStore.set('second-opener', sessionOnDevice('second-opener'));
    order.push('second');
    return 'second-opened';
  });

  await expect(firstOpened).resolves.toBe('first-opened');
  await expect(secondOpened).resolves.toBe('second-opened');
  expect(order).toEqual(['first', 'second']);

  // Both opened inside the budget, so neither owes a caller a story about one that ran out.
  expect(Date.now() - startedAtMs).toBeLessThan(WAIT_BUDGET_MS);
  expect(readOpenWaitAttempt(first.req)).toEqual({});
  expect(readOpenWaitAttempt(second.req)).toEqual({});
});

// An open that waited while holding the device lock would stall the only command able to end its
// wait. So the open's locked work is already in flight when the `close` starts, and the close still
// has to get through — well inside a budget the waiting open has no hope of finishing meantime.
test('a close that frees the device mid-wait gets through while the open is waiting', async () => {
  const sessionStore = makeSessionStore('agent-device-open-wait-close-');
  const leaseRegistry = new LeaseRegistry();
  sessionStore.set('holder', sessionOnDevice('holder'));
  const order: string[] = [];

  const opened = createRequestExecutionScope({
    req: openRequest('waiter'),
    sessionStore,
    leaseRegistry,
  }).then((scope) =>
    scope.runLocked(async () => {
      order.push('open-bound');
      sessionStore.set('waiter', sessionOnDevice('waiter'));
      return 'opened';
    }),
  );
  await sleep(50);
  const closer = await createRequestExecutionScope({
    req: closeRequest('holder'),
    sessionStore,
    leaseRegistry,
  });

  const closedAtMs = Date.now();
  await expect(
    closer.runLocked(async () => {
      order.push('close-freed-the-device');
      sessionStore.delete('holder');
      return 'closed';
    }),
  ).resolves.toBe('closed');
  expect(Date.now() - closedAtMs).toBeLessThan(WAIT_BUDGET_MS);

  await expect(opened).resolves.toBe('opened');
  expect(order).toEqual(['close-freed-the-device', 'open-bound']);
});

afterAll(() => {
  vi.useRealTimers();
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
});
