import { test, expect, vi, afterEach } from 'vitest';
import path from 'node:path';
import type { CommandFlags } from '@agent-device/contracts/command';
import { clearRequestCanceled, markRequestCanceled } from '@agent-device/host-kit/request';
import { IOS_SIMULATOR } from '../../__tests__/test-utils/device-fixtures.ts';
import type { DaemonRequest } from '../daemon-request.ts';
import type { SessionState } from '../session-state.ts';
import { SessionStore } from '../session-store.ts';
import {
  readOpenWaitAttempt,
  readOpenWaitBudgetMs,
  waitForOpenDeviceContention,
} from '../open-device-contention-wait.ts';

// `--wait <ms>` is the one answer to a device another session is holding. What makes this wait
// safe is where it runs: outside the device execution lock, because every operation that could
// free the device needs that lock too. These tests pin the loop's accounting and the one case it
// must never wait on — its own session.

const HOLDER_ADDRESS = 'cwd:8bea844ab16aa9b3:default';

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

function storeWithHolder(deviceId = IOS_SIMULATOR.id): SessionStore {
  const store = new SessionStore(
    path.join('/tmp', `ad-wait-${Math.random().toString(36).slice(2)}`),
  );
  const holder: SessionState = {
    name: 'default',
    sessionScope: { kind: 'cwd', id: '8bea844ab16aa9b3' },
    device: { ...IOS_SIMULATOR, id: deviceId },
    createdAt: 0,
    actions: [],
  };
  store.set(HOLDER_ADDRESS, holder);
  return store;
}

function resolved(device: typeof IOS_SIMULATOR | undefined) {
  let calls = 0;
  return {
    calls: () => calls,
    resolve: async () => {
      calls += 1;
      return device;
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
  clearRequestCanceled('req-open-wait');
});

test('the budget is read from the request, and a non-positive one is no budget', () => {
  expect(readOpenWaitBudgetMs(openRequest({ waitMs: 5000 }))).toBe(5000);
  expect(readOpenWaitBudgetMs(openRequest({}))).toBeUndefined();
  expect(readOpenWaitBudgetMs(openRequest({ waitMs: 0 }))).toBeUndefined();
});

test('a free device costs nothing and records no wait', async () => {
  const req = openRequest({ waitMs: 30_000 });
  const device = resolved(IOS_SIMULATOR);

  await waitForOpenDeviceContention({
    req,
    sessionName: 'cwd:1d9b7c2f4a6e8b03:default',
    sessionStore: new SessionStore('/tmp/ad-wait-free'),
    budgetMs: 30_000,
    resolveDevice: device.resolve,
  });

  expect(device.calls()).toBe(1);
  expect(readOpenWaitAttempt(req)).toEqual({});
});

// An open onto the device its own session already holds is not contention: waiting there would
// spend the whole budget on itself.
test('the session that already holds the device is not waited for', async () => {
  const req = openRequest({ waitMs: 30_000 });
  const store = storeWithHolder();

  await waitForOpenDeviceContention({
    req,
    sessionName: HOLDER_ADDRESS,
    sessionStore: store,
    budgetMs: 30_000,
    resolveDevice: resolved(IOS_SIMULATOR).resolve,
  });

  expect(readOpenWaitAttempt(req)).toEqual({});
});

test('a device that frees up ends the wait and records what it cost', async () => {
  vi.useFakeTimers();
  const req = openRequest({ waitMs: 30_000 });
  const store = storeWithHolder();
  let looks = 0;

  let settled = false;
  const running = waitForOpenDeviceContention({
    req,
    sessionName: 'cwd:1d9b7c2f4a6e8b03:default',
    sessionStore: store,
    budgetMs: 30_000,
    resolveDevice: async () => {
      looks += 1;
      if (looks > 2) store.delete(HOLDER_ADDRESS);
      return IOS_SIMULATOR;
    },
  }).then(() => {
    settled = true;
  });
  await vi.advanceTimersByTimeAsync(1_000);
  await running;

  expect(settled).toBe(true);
  expect(readOpenWaitAttempt(req).waitedMs).toBeGreaterThan(0);
});

test('a budget that runs out busy records the spend and lets the open refuse', async () => {
  vi.useFakeTimers();
  const req = openRequest({ waitMs: 1000 });
  const device = resolved(IOS_SIMULATOR);

  const running = waitForOpenDeviceContention({
    req,
    sessionName: 'cwd:1d9b7c2f4a6e8b03:default',
    sessionStore: storeWithHolder(),
    budgetMs: 1000,
    resolveDevice: device.resolve,
  });
  await vi.advanceTimersByTimeAsync(10_000);
  await running;

  expect(readOpenWaitAttempt(req).waitedMs).toBe(1000);
  // 250ms polls across a 1000ms budget: never an unbounded spin.
  expect(device.calls()).toBe(5);
});

test('a device that cannot be resolved yet is not waited for', async () => {
  const req = openRequest({ waitMs: 30_000 });
  const device = resolved(undefined);

  await waitForOpenDeviceContention({
    req,
    sessionName: 'cwd:1d9b7c2f4a6e8b03:default',
    sessionStore: storeWithHolder(),
    budgetMs: 30_000,
    resolveDevice: device.resolve,
  });

  expect(device.calls()).toBe(1);
  expect(readOpenWaitAttempt(req)).toEqual({});
});

test('a request the client gave up on stops waiting at its next poll', async () => {
  vi.useFakeTimers();
  const req = openRequest({ waitMs: 60_000 });
  markRequestCanceled('req-open-wait');

  const running = waitForOpenDeviceContention({
    req,
    sessionName: 'cwd:1d9b7c2f4a6e8b03:default',
    sessionStore: storeWithHolder(),
    budgetMs: 60_000,
    resolveDevice: resolved(IOS_SIMULATOR).resolve,
  });
  const rejection = expect(running).rejects.toThrow();
  await vi.advanceTimersByTimeAsync(250);

  await rejection;
});
