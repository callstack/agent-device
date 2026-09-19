import { test, expect, vi, afterEach } from 'vitest';
import { isRequestCanceledError } from '@agent-device/kernel/errors';
import type { CommandFlags } from '@agent-device/contracts/command';
import { clearRequestCanceled, markRequestCanceled } from '@agent-device/host-kit/request';
import { IOS_SIMULATOR } from '../../__tests__/test-utils/device-fixtures.ts';
import { getFlagDefinitionsForKey } from '@agent-device/command-registry/flag-registry';
import { makeSessionStore } from '../../__tests__/test-utils/store-factory.ts';
import type { DaemonRequest } from '../daemon-request.ts';
import type { SessionState } from '../session-state.ts';
import { SessionStore } from '../session-store.ts';
import {
  beginOpenDeviceWait,
  describeOpenWaitForRefusal,
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
  store.set(HOLDER_ADDRESS, session(HOLDER_ADDRESS));
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
  const sessionStore = new SessionStore('/tmp/ad-wait-none');
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
  sessionStore.set(OPENER_ADDRESS, session(OPENER_ADDRESS));
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
  const release = setTimeout(() => store.delete(HOLDER_ADDRESS), 600);

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
  setTimeout(() => store.delete(HOLDER_ADDRESS), 300);
  const trace = lockTrace({
    onAcquire: (pass) => {
      if (pass === 1) store.set(HOLDER_ADDRESS, session(HOLDER_ADDRESS));
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

/** Runs `start()` under fake timers and advances the clock until it settles. */
async function waitUntil(start: () => Promise<void>, budgetMs: number): Promise<void> {
  const running = start();
  await vi.advanceTimersByTimeAsync(budgetMs);
  await running;
}
