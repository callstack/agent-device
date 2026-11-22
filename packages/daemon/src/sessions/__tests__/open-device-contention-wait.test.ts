import { test, expect, vi, afterEach } from 'vitest';
import { isRequestCanceledError } from '@agent-device/kernel/errors';
import type { CommandFlags } from '@agent-device/contracts/command';
import {
  clearRequestCanceled,
  markRequestCanceled,
  withRequestProgressSink,
} from '@agent-device/host-kit/request';
import { IOS_SIMULATOR, createLiveTestHostEnvironment } from '@agent-device/test-kit';
import { getFlagDefinitionsForKey } from '@agent-device/command-registry/flag-registry';
import { makeSessionStore } from '../../__tests__/support/store-factory.ts';
import type { DaemonRequest } from '../../core/daemon-request.ts';
import type { SessionState } from '../../core/session-state.ts';
import { SessionStore } from '../../core/session-store.ts';
import {
  beginOpenDeviceWait,
  describeOpenWaitForRefusal,
  findSessionDeviceConflict,
  readOpenWaitAttempt,
  readOpenWaitBudgetMs,
} from '../open-device-contention-wait.ts';

// `--wait <ms>` is the one answer to a device another session is holding. Two things make that
// wait trustworthy, and both are pinned here: it runs outside the device execution lock, because
// every operation that could free the device needs that lock too; and the open re-looks at the
// device under the locks, so a device taken in the window between the last look and the lock is
// waited for again instead of refused with budget still unspent.

const HOLDER_ADDRESS = 'cwd:8bea844ab16aa9b3:default';
const OPENER_ADDRESS = 'cwd:1d9b7c2f4a6e8b03:default';

function openRequest(flags: CommandFlags): DaemonRequest {
  return {
    token: 'token',
    session: 'default',
    command: 'open',
    positionals: [],
    flags,
    meta: { requestId: 'req-open-wait' },
  };
}

function beginWait(
  params: Omit<Parameters<typeof beginOpenDeviceWait>[0], 'budgetMs'>,
): ReturnType<typeof beginOpenDeviceWait> {
  return beginOpenDeviceWait({
    ...params,
    budgetMs: readOpenWaitBudgetMs(params.req),
  });
}

function session(address: string): SessionState {
  return {
    name: 'default',
    sessionScope: { kind: 'cwd', id: address.split(':')[1] ?? '' },
    device: IOS_SIMULATOR,
    createdAt: 0,
    actions: [],
  };
}

function storeWithHolder(): SessionStore {
  const store = makeSessionStore('agent-device-open-wait-');
  store.publish(HOLDER_ADDRESS, session(HOLDER_ADDRESS));
  return store;
}

/** Drives {@link OpenDeviceWait.runWhenDeviceIsUnheld} the way the request scope does, and keeps
 * the order the locks, the open, and any re-wait actually happened in. */
function lockTrace(params: { onAcquire?: (pass: number) => void }) {
  const order: string[] = [];
  let passes = 0;
  return {
    order,
    acquireLocks: async <T>(task: () => Promise<T>): Promise<T> => {
      passes += 1;
      order.push('acquire');
      params.onAcquire?.(passes);
      const outcome = await task();
      order.push('release');
      return outcome;
    },
  };
}

function thrownBy(build: () => unknown): unknown {
  try {
    build();
  } catch (error) {
    return error;
  }
  throw new Error('Expected the request to be refused.');
}

afterEach(() => {
  vi.useRealTimers();
  clearRequestCanceled('req-open-wait');
});

// The CLI parser refuses a `--wait` outside the option's declared bounds and the tool input derived
// from it refuses the same. A budget assembled by the Node client or posted straight to the wire
// reaches the daemon with neither check applied, so the reader that spends it applies the bounds of
// the same declaration rather than a copy of them.
test('the daemon holds a budget to the bounds its own option declares', () => {
  const [waitFlag] = getFlagDefinitionsForKey('waitMs');
  const { min, max } = waitFlag ?? {};
  expect({ min, max }).toEqual({ min: expect.any(Number), max: expect.any(Number) });

  expect(readOpenWaitBudgetMs(openRequest({ waitMs: 5_000 }))).toBe(5_000);
  expect(readOpenWaitBudgetMs(openRequest({ waitMs: min }))).toBe(min);
  expect(readOpenWaitBudgetMs(openRequest({ waitMs: max }))).toBe(max);
  expect(readOpenWaitBudgetMs(openRequest({}))).toBeUndefined();

  for (const waitMs of [(min ?? 0) - 1, (max ?? 0) + 1, 0, 1.5]) {
    expect(thrownBy(() => readOpenWaitBudgetMs(openRequest({ waitMs })))).toMatchObject({
      code: 'INVALID_ARGS',
    });
  }
});

test('a refusal offers the flag only to a caller that did not arrive carrying it', () => {
  expect(describeOpenWaitForRefusal(openRequest({}))).toEqual({ offersDeviceWait: true });

  // An interaction has no `--wait` of its own, even though the shared refusal builder may one day
  // receive its request.
  expect(describeOpenWaitForRefusal({ ...openRequest({}), command: 'tap' })).toEqual({
    offersDeviceWait: false,
  });

  // The open that passed `--wait` and still hit a busy device is not being sent off to run the
  // same open with the flag it used.
  const carried = openRequest({ waitMs: 1_000 });
  expect(describeOpenWaitForRefusal(carried)).toEqual({ offersDeviceWait: false });

  const spent: DaemonRequest = { ...carried, internal: { openDeviceWait: { waitedMs: 1_000 } } };
  expect(describeOpenWaitForRefusal(spent)).toEqual({ waitedMs: 1_000, offersDeviceWait: false });
});

test('only a fresh open with a budget and a resolved device gets a wait', () => {
  const sessionStore = new SessionStore('/tmp/ad-wait-none', createLiveTestHostEnvironment());
  const budget = openRequest({ waitMs: 5_000 });

  expect(
    beginWait({
      req: { ...budget, command: 'tap' },
      sessionName: OPENER_ADDRESS,
      sessionStore,
      deviceId: IOS_SIMULATOR.id,
    }),
  ).toBeUndefined();
  expect(
    beginWait({
      req: budget,
      sessionName: OPENER_ADDRESS,
      sessionStore,
      deviceId: undefined,
    }),
  ).toBeUndefined();
  expect(
    beginWait({
      req: openRequest({}),
      sessionName: OPENER_ADDRESS,
      sessionStore,
      deviceId: IOS_SIMULATOR.id,
    }),
  ).toBeUndefined();

  // An open onto a session that already exists is bound to a device nobody else is refused for.
  sessionStore.publish(OPENER_ADDRESS, session(OPENER_ADDRESS));
  expect(
    beginWait({
      req: budget,
      sessionName: OPENER_ADDRESS,
      sessionStore,
      deviceId: IOS_SIMULATOR.id,
    }),
  ).toBeUndefined();
});

test('a free device is read once in the store and records no wait', async () => {
  const req = openRequest({ waitMs: 30_000 });
  const store = makeSessionStore('agent-device-open-wait-');
  const looks = vi.spyOn(store, 'findByDevice');

  const wait = beginWait({
    req,
    sessionName: OPENER_ADDRESS,
    sessionStore: store,
    deviceId: IOS_SIMULATOR.id,
  })!;
  await wait.waitForDeviceOutsideLocks();

  expect(looks).toHaveBeenCalledTimes(1);
  expect(readOpenWaitAttempt(req)).toEqual({});
});

test('a device that frees up ends the wait without claiming a spent budget', async () => {
  vi.useFakeTimers();
  const req = openRequest({ waitMs: 30_000 });
  const store = storeWithHolder();
  const holder = store.lookup(HOLDER_ADDRESS)!;
  const release = setTimeout(() => store.retire(holder), 600);

  await waitUntil(
    () =>
      beginWait({
        req,
        sessionName: OPENER_ADDRESS,
        sessionStore: store,
        deviceId: IOS_SIMULATOR.id,
      })!.waitForDeviceOutsideLocks(),
    30_000,
  );
  clearTimeout(release);

  // The open this wait hands off to succeeds, and only a refusal may report a wait.
  expect(readOpenWaitAttempt(req)).toEqual({});
});

test('an open yields the device lock to a session that took the device after the last look', async () => {
  vi.useFakeTimers();
  const req = openRequest({ waitMs: 30_000 });
  const store = makeSessionStore('agent-device-open-wait-');
  const wait = beginWait({
    req,
    sessionName: OPENER_ADDRESS,
    sessionStore: store,
    deviceId: IOS_SIMULATOR.id,
  })!;
  // A competing open puts its session on the device in the window between this open's look at the
  // free store and its first pass under the locks, and hands it back 300ms later.
  const trace = lockTrace({
    onAcquire: (pass) => {
      if (pass === 1) {
        const holder = store.publish(HOLDER_ADDRESS, session(HOLDER_ADDRESS));
        setTimeout(() => store.retire(holder), 300);
      }
    },
  });

  let opened = 0;
  const running = wait
    .runWhenDeviceIsUnheld({
      acquireLocks: trace.acquireLocks,
      task: async () => {
        opened += 1;
        return 'opened';
      },
    })
    .then((outcome) => {
      expect(outcome).toBe('opened');
    });
  await vi.advanceTimersByTimeAsync(1_000);
  await running;

  // Two passes at the locks with one wait between them, and the open ran only while it held them.
  expect(trace.order).toEqual(['acquire', 'release', 'acquire', 'release']);
  expect(opened).toBe(1);
  expect(readOpenWaitAttempt(req)).toEqual({});
});

test('a budget that runs out busy costs the whole budget, then lets the open refuse', async () => {
  vi.useFakeTimers();
  const req = openRequest({ waitMs: 1000 });
  const store = storeWithHolder();
  const looks = vi.spyOn(store, 'findByDevice');
  const wait = beginWait({
    req,
    sessionName: OPENER_ADDRESS,
    sessionStore: store,
    deviceId: IOS_SIMULATOR.id,
  })!;
  const trace = lockTrace({});

  let opened = 0;
  const running = wait
    .runWhenDeviceIsUnheld({
      acquireLocks: trace.acquireLocks,
      task: async () => {
        opened += 1;
        return 'refused';
      },
    })
    .then((outcome) => {
      expect(outcome).toBe('refused');
    });
  await vi.advanceTimersByTimeAsync(10_000);
  await running;

  expect(readOpenWaitAttempt(req).waitedMs).toBe(1000);
  // The refusal is the open's own, so the task ran — once, under the locks, after the budget that
  // bought the second pass was gone.
  expect(opened).toBe(1);
  expect(trace.order).toEqual(['acquire', 'release', 'acquire', 'release']);
  // 250ms polls across a 1000ms budget, plus one look per pass at the locks: never a spin.
  expect(looks.mock.calls.length).toBeLessThanOrEqual(7);
});

test('a request the client gave up on stops waiting at its next poll', async () => {
  vi.useFakeTimers();
  const req = openRequest({ waitMs: 60_000 });
  markRequestCanceled('req-open-wait');
  const wait = beginWait({
    req,
    sessionName: OPENER_ADDRESS,
    sessionStore: storeWithHolder(),
    deviceId: IOS_SIMULATOR.id,
  })!;

  const rejection = expect(wait.waitForDeviceOutsideLocks()).rejects.toSatisfy(
    isRequestCanceledError,
  );
  await vi.advanceTimersByTimeAsync(250);

  await rejection;
});

// The contention progress names the holder only when that holder is visible to the request
// (#4923). The visible case is the two cwd sessions above; the anonymous case is another tenant's
// leased session.
test('the open-wait progress names a holder the request may see', async () => {
  vi.useFakeTimers();
  const messages: string[] = [];
  const req = openRequest({ waitMs: 1000 });
  const wait = beginWait({
    req,
    sessionName: OPENER_ADDRESS,
    sessionStore: storeWithHolder(),
    deviceId: IOS_SIMULATOR.id,
  })!;

  await waitUntil(
    () =>
      withRequestProgressSink(
        (event) => messages.push(event.type === 'command' ? event.message : ''),
        () => wait.waitForDeviceOutsideLocks(),
      ),
    2_000,
  );

  expect(messages[0]).toContain(`held by session "${HOLDER_ADDRESS}"`);
});

test('the open-wait progress names no holder the request may not see', async () => {
  vi.useFakeTimers();
  const messages: string[] = [];
  const store = makeSessionStore('agent-device-open-wait-');
  store.publish('e2b:agentA', {
    name: 'agentA',
    sessionScope: { kind: 'tenant', id: 'e2b' },
    lease: {
      leaseId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      tenantId: 'e2b',
      runId: 'run-a',
      backend: 'ios-simulator',
    },
    device: IOS_SIMULATOR,
    createdAt: 0,
    actions: [],
  });
  const req: DaemonRequest = {
    ...openRequest({ waitMs: 1000 }),
    session: 'agentB',
    meta: { requestId: 'req-open-wait', tenantId: 'e2b', sessionIsolation: 'tenant' },
  };
  const wait = beginWait({
    req,
    sessionName: 'e2b:agentB',
    sessionStore: store,
    deviceId: IOS_SIMULATOR.id,
  })!;

  await waitUntil(
    () =>
      withRequestProgressSink(
        (event) => messages.push(event.type === 'command' ? event.message : ''),
        () => wait.waitForDeviceOutsideLocks(),
      ),
    2_000,
  );

  expect(messages[0]).toContain('held by another session');
  expect(messages[0]).not.toContain('agentA');
});

/** Runs `start()` under fake timers and advances the clock until it settles. */
async function waitUntil(start: () => Promise<void>, budgetMs: number): Promise<void> {
  const running = start();
  await vi.advanceTimersByTimeAsync(budgetMs);
  await running;
}

// The refusal a contended open gets names the holder unless the holder is another proxy client's
// leased or tenant-scoped session (#4923). These cases are the whole table: same workspace,
// another client's leased session on a shared token, and another local workspace's session.
test('the contention refusal names a holder the request may see', () => {
  const store = storeWithHolder();
  const conflict = findSessionDeviceConflict({
    req: openRequest({}),
    device: IOS_SIMULATOR,
    sessionStore: store,
    sessionName: OPENER_ADDRESS,
  });

  expect(conflict?.error.message).toBe(`Device is already in use by session "${HOLDER_ADDRESS}".`);
  expect(conflict?.error.details?.session).toBe(HOLDER_ADDRESS);
});

test('the contention refusal names no session to a caller that may not see it', () => {
  const store = makeSessionStore('agent-device-open-wait-');
  store.publish('e2b:agentA', {
    name: 'agentA',
    sessionScope: { kind: 'tenant', id: 'e2b' },
    lease: {
      leaseId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      tenantId: 'e2b',
      runId: 'run-a',
      backend: 'ios-simulator',
    },
    device: IOS_SIMULATOR,
    createdAt: 0,
    actions: [],
  });
  const conflict = findSessionDeviceConflict({
    req: {
      ...openRequest({}),
      session: 'agentB',
      meta: { requestId: 'req-open-wait', tenantId: 'e2b', sessionIsolation: 'tenant' },
    },
    device: IOS_SIMULATOR,
    sessionStore: store,
    sessionName: 'e2b:agentB',
  });

  expect(conflict?.error.code).toBe('DEVICE_IN_USE');
  expect(conflict?.error.message).toBe('Device is already in use by another session.');
  expect(conflict?.error.details?.session).toBeUndefined();
  expect(String(conflict?.error.details?.hint)).not.toContain('agentA');
});

test('a request carrying the holder lease id still gets the named refusal', () => {
  const store = makeSessionStore('agent-device-open-wait-');
  store.publish('e2b:agentA', {
    name: 'agentA',
    sessionScope: { kind: 'tenant', id: 'e2b' },
    lease: {
      leaseId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      tenantId: 'e2b',
      runId: 'run-a',
      backend: 'ios-simulator',
    },
    device: IOS_SIMULATOR,
    createdAt: 0,
    actions: [],
  });
  const conflict = findSessionDeviceConflict({
    req: {
      ...openRequest({}),
      session: 'agentA',
      meta: {
        requestId: 'req-open-wait',
        tenantId: 'e2b',
        sessionIsolation: 'tenant',
        leaseId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      },
    },
    device: IOS_SIMULATOR,
    sessionStore: store,
    // A reopen attempt under a different name still contends with the holder.
    sessionName: 'e2b:agentA-reopen',
  });

  expect(conflict?.error.message).toContain('e2b:agentA');
});

// A holder in another local workspace keeps its address: the owner closes it from that folder
// with the named address (#2580).
test('the foreign-workspace conflict names the holder address', () => {
  const store = storeWithHolder();
  const conflict = findSessionDeviceConflict({
    req: { ...openRequest({}), meta: { requestId: 'req-open-wait', cwd: '/worktrees/other' } },
    device: IOS_SIMULATOR,
    sessionStore: store,
    sessionName: OPENER_ADDRESS,
  });

  expect(conflict?.error.details).toMatchObject({
    reason: 'WORKSPACE_SESSION_SCOPE_CONFLICT',
    session: HOLDER_ADDRESS,
  });
  expect(conflict?.error.message).toBe(
    `Device is already in use by workspace session "${HOLDER_ADDRESS}".`,
  );
});
