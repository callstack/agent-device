import { afterAll, test, expect, vi } from 'vitest';
import fs from 'node:fs';
import { getFlagDefinitionsForKey } from '@agent-device/command-registry/flag-registry';
import type { CommandFlags } from '@agent-device/contracts/command';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { resolveTargetDevice } from '@agent-device/device-selection/dispatch-resolve';
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

function openRequest(
  session: string,
  waitMs: number = WAIT_BUDGET_MS,
  requestId = `req-${session}`,
): DaemonRequest {
  const flags: CommandFlags = { waitMs };
  return {
    token: 'token',
    session,
    command: 'open',
    positionals: [],
    flags,
    meta: { cwd: TEST_ROOT, requestId },
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
//
// The task below has to refuse just like the real open does when it finds another session on the
// device. Without that check it would open after simply waiting on the lock, and the test would
// pass even if runLocked stopped calling runWhenDeviceIsUnheld and did not re-check device
// contention.
type OpenOutcome = string;

function openOnUncontendedDevice(
  scope: Awaited<ReturnType<typeof createRequestExecutionScope>>,
  name: string,
  sessionStore: ReturnType<typeof makeSessionStore>,
  order: string[],
): Promise<OpenOutcome> {
  return scope.runLocked(async () => {
    const currentOwner = sessionStore.findByDevice(CONTESTED_DEVICE.id);
    if (currentOwner && currentOwner.address !== scope.sessionName) {
      return `refused:${currentOwner.address}`;
    }

    sessionStore.set(name, sessionOnDevice(name));
    order.push(name);
    return `opened:${name}`;
  });
}

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
  // Each open binds a device to its own session under its own device lock, which is what a real
  // open does. The second can therefore only get in once the first releases it.
  const firstOpened = openOnUncontendedDevice(first, 'first-opener', sessionStore, order);
  const secondOpened = openOnUncontendedDevice(second, 'second-opener', sessionStore, order);

  await expect(firstOpened).resolves.toBe('opened:first-opener');
  await expect(secondOpened).resolves.toBe('opened:second-opener');
  expect(order).toEqual(['first-opener', 'second-opener']);

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

// A Node client or raw wire request can carry a budget the CLI parser would have rejected. The
// daemon must reject it at its own request boundary before the device is resolved. This catches
// regression where example stored plans compute a device before budget validation.
test('an out-of-range wait budget is refused before resolving the target device', async () => {
  const max = getFlagDefinitionsForKey('waitMs')[0]?.max;
  if (typeof max !== 'number') {
    throw new Error('waitMs declaration lost its maximum');
  }

  const resolveCallsBefore = vi.mocked(resolveTargetDevice).mock.calls.length;
  await expect(
    createRequestExecutionScope({
      req: openRequest('unbounded-opener', max + 1, 'request-unbounded'),
      sessionStore: makeSessionStore('agent-device-open-wait-bounds-'),
      leaseRegistry: new LeaseRegistry(),
    }),
  ).rejects.toMatchObject({ code: 'INVALID_ARGS' });
  expect(vi.mocked(resolveTargetDevice).mock.calls.length).toBe(resolveCallsBefore);
});

afterAll(() => {
  vi.useRealTimers();
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
});
