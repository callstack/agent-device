import crypto from 'node:crypto';
import path from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { LeaseRequestStatus } from '@agent-device/contracts/managed-device-allocation';
import { createAllocationOperationStore } from '@agent-device/managed-allocation/store';
import { createScriptedManagedDeviceAllocator } from '../../../__tests__/test-utils/managed-device-allocator.fixtures.ts';
import { mkdtempForTestSync } from '../../../__tests__/test-utils/tmp-dir.ts';
import {
  createManagedLeaseCoordinator,
  type ManagedLeaseBinding,
  type ManagedLeaseHandoff,
} from '../lease-coordinator.ts';
import { ALLOCATION_REQUEST } from './fixtures.ts';
import {
  NOW,
  controller,
  deferred,
  granted,
  horizon,
  renewedLease,
} from './lease-admission.fixtures.ts';

const OWNER = ALLOCATION_REQUEST.requesterId;
const SHAPE = ALLOCATION_REQUEST.shape;
const RENEW_INTERVAL_MS = 30_000;
const POLL_INTERVAL_MS = 1_000;
const pending: LeaseRequestStatus = { ...granted(), state: 'pending', lease: undefined };
const cancelled: LeaseRequestStatus = { ...pending, state: 'cancelled' };

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  // The coordinator mints the attempt key; pinning it lets scripted statuses name the attempt.
  vi.spyOn(crypto, 'randomUUID').mockReturnValue(
    ALLOCATION_REQUEST.attemptKey as ReturnType<typeof crypto.randomUUID>,
  );
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

type Script = NonNullable<Parameters<typeof createScriptedManagedDeviceAllocator>[0]>['script'];

async function setup(
  script: Script,
  handoff: Partial<ManagedLeaseHandoff> = {},
  failTransition?: string,
) {
  const root = mkdtempForTestSync('managed-lease-coordinator-');
  const durable = createAllocationOperationStore({
    allocationsDir: path.join(root, 'allocations'),
  });
  const store: typeof durable = {
    ...durable,
    transition: async (...args) => {
      if (args[2].kind === failTransition) throw new Error('disk full');
      return await durable.transition(...args);
    },
  };
  const events: string[] = [];
  // Each start is one daemon process over the same durable journal.
  const start = async (steps: Script) => {
    const allocator = createScriptedManagedDeviceAllocator({ script: steps });
    const coordinator = await createManagedLeaseCoordinator({
      store,
      allocator,
      renewIntervalMs: RENEW_INTERVAL_MS,
      renewalSafetyWindowMs: 5_000,
      pollIntervalMs: POLL_INTERVAL_MS,
      teardownTimeoutMs: 5_000,
      handoff: {
        publish: handoff.publish ?? (async () => void events.push('publish')),
        teardown: async (binding) => {
          events.push(`teardown after ${allocator.calls.map((call) => call.method).join(',')}`);
          await handoff.teardown?.(binding);
        },
      },
    });
    return { allocator, coordinator };
  };
  const { allocator, coordinator } = await start(script);
  const recordFor = () => {
    const read = durable.read(ALLOCATION_REQUEST);
    if (read.status !== 'found') throw new Error(`expected a journal record, got ${read.status}`);
    return read.record;
  };
  const acquire = (overrides: { deadlineAtMs?: number; signal?: AbortSignal } = {}) =>
    coordinator.acquire({
      owner: OWNER,
      shape: SHAPE,
      deadlineAtMs: overrides.deadlineAtMs ?? NOW + 60_000,
      ...(overrides.signal ? { signal: overrides.signal } : {}),
    });
  return { allocator, coordinator, events, recordFor, acquire, restart: start };
}

async function fencedStatus(binding: ManagedLeaseBinding) {
  return (await binding.admission.run(horizon(), controller().signal, async () => {})).status;
}

test('a granted device is journaled, published, and released only after it is fenced and torn down', async () => {
  const { allocator, coordinator, events, recordFor, acquire } = await setup({
    requestLease: [granted()],
    releaseLease: [undefined],
  });

  const acquisition = await acquire();

  expect(acquisition.status).toBe('granted');
  if (acquisition.status !== 'granted') return;
  expect(acquisition.binding.owner).toBe(OWNER);
  expect(acquisition.binding.admission.reachability.device.simulatorSetPath).toBe('/managed/set');
  expect(coordinator.binding(OWNER)).toBe(acquisition.binding);
  expect(recordFor()).toMatchObject({ requestGeneration: 1, binding: 'published' });
  expect(allocator.calls[0]).toMatchObject({
    method: 'requestLease',
    input: { requesterId: OWNER, attemptKey: 'attempt-1', admission: 'fail-fast', shape: SHAPE },
  });

  expect(await coordinator.release(OWNER)).toEqual({ status: 'released' });
  expect(events).toEqual(['publish', 'teardown after requestLease']);
  expect(allocator.calls.map((call) => call.method)).toEqual(['requestLease', 'releaseLease']);
  expect(await fencedStatus(acquisition.binding)).toBe('teardown-required');
  expect(coordinator.binding(OWNER)).toBeUndefined();
  expect(recordFor()).toMatchObject({ binding: 'cleaned', release: 'released' });
  expect(await coordinator.release(OWNER)).toEqual({ status: 'not-held' });
});

test('a pending request is looked up until the allocator grants it', async () => {
  const { allocator, events, acquire } = await setup({
    requestLease: [pending],
    getLeaseRequestStatus: [pending, granted()],
  });

  const acquisition = acquire();
  await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 2);

  expect((await acquisition).status).toBe('granted');
  expect(allocator.calls.map((call) => call.method)).toEqual([
    'requestLease',
    'getLeaseRequestStatus',
    'getLeaseRequestStatus',
  ]);
  expect(events).toEqual(['publish']);
});

test('a capacity refusal is returned with its retry delay and frees the owner', async () => {
  const refusal = { reason: 'simulator-capacity', retryAfterMs: 30_000 } as const;
  const { coordinator, events, acquire } = await setup({
    requestLease: [{ ...pending, state: 'refused', refusal }],
  });

  expect(await acquire()).toEqual({ status: 'refused', refusal });
  expect(events).toEqual([]);
  expect(await coordinator.release(OWNER)).toEqual({ status: 'not-held' });
});

test('a request still pending at its deadline is cancelled with the allocator', async () => {
  const { allocator, events, recordFor, acquire } = await setup({
    requestLease: [pending],
    getLeaseRequestStatus: [pending, pending],
    cancelLeaseRequest: [cancelled],
  });

  const acquisition = acquire({ deadlineAtMs: NOW + POLL_INTERVAL_MS * 2 });
  await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 3);

  expect(await acquisition).toMatchObject({ status: 'unavailable', reason: 'deadline-exceeded' });
  expect(allocator.calls.at(-1)?.method).toBe('cancelLeaseRequest');
  expect(recordFor().phase.status).toBe('cancelled');
  expect(events).toEqual([]);
});

test('one owner holds at most one device at a time', async () => {
  const { coordinator, acquire } = await setup({ requestLease: [granted()] });

  expect((await acquire()).status).toBe('granted');
  expect(
    await coordinator.acquire({ owner: OWNER, shape: SHAPE, deadlineAtMs: NOW + 60_000 }),
  ).toMatchObject({ status: 'unavailable', reason: 'owner-busy' });
});

test('a held device stays renewed between commands', async () => {
  const { allocator, acquire } = await setup({
    requestLease: [granted({ lease: renewedLease({ ttlDeadline: NOW + 40_000 }) })],
    renewLease: [renewedLease({ ttlDeadline: NOW + 70_000 })],
  });

  expect((await acquire()).status).toBe('granted');
  await vi.advanceTimersByTimeAsync(RENEW_INTERVAL_MS);

  expect(allocator.calls.map((call) => call.method)).toEqual(['requestLease', 'renewLease']);
});

test('a lease the allocator stops confirming is fenced, torn down, and released', async () => {
  const { allocator, coordinator, events, acquire } = await setup({
    requestLease: [granted({ lease: renewedLease({ ttlDeadline: NOW + 40_000 }) })],
    renewLease: [new Error('allocator unreachable')],
    getLeaseRequestStatus: [new Error('allocator unreachable')],
    releaseLease: [undefined],
  });

  const acquisition = await acquire();
  if (acquisition.status !== 'granted') throw new Error('expected a grant');
  await vi.advanceTimersByTimeAsync(RENEW_INTERVAL_MS);

  expect(events).toEqual([
    'publish',
    'teardown after requestLease,renewLease,getLeaseRequestStatus',
  ]);
  expect(allocator.calls.at(-1)?.method).toBe('releaseLease');
  expect(coordinator.binding(OWNER)).toBeUndefined();
  expect(await fencedStatus(acquisition.binding)).toBe('teardown-required');
});

test('a failed handoff is torn down and its lease released', async () => {
  const { allocator, events, acquire } = await setup(
    { requestLease: [granted()], releaseLease: [undefined] },
    {
      publish: async () => {
        throw new Error('session unavailable');
      },
    },
  );

  expect(await acquire()).toMatchObject({ status: 'unavailable', reason: 'handoff-failed' });
  expect(events).toEqual(['teardown after requestLease']);
  expect(allocator.calls.at(-1)?.method).toBe('releaseLease');
});

test('releasing during acquisition gives back a grant that arrives late', async () => {
  const late = deferred<LeaseRequestStatus>();
  const { allocator, coordinator, events, recordFor, acquire } = await setup({
    requestLease: [late.promise],
    releaseLease: [undefined],
  });

  const acquisition = acquire();
  await vi.advanceTimersByTimeAsync(0);
  const released = coordinator.release(OWNER);
  late.resolve(granted());

  expect(await released).toEqual({ status: 'released' });
  expect(await acquisition).toMatchObject({ status: 'unavailable', reason: 'abandoned' });
  expect(events).toEqual([]);
  expect(allocator.calls.map((call) => call.method)).toEqual(['requestLease', 'releaseLease']);
  expect(recordFor()).toMatchObject({ binding: 'cleaned', release: 'released' });
  expect(coordinator.binding(OWNER)).toBeUndefined();
});

test('disposal stops renewal without releasing, leaving the lease to restart recovery', async () => {
  const { allocator, coordinator, events, recordFor, acquire } = await setup({
    requestLease: [granted({ lease: renewedLease({ ttlDeadline: NOW + 40_000 }) })],
  });

  expect((await acquire()).status).toBe('granted');
  await coordinator[Symbol.asyncDispose]();
  await vi.advanceTimersByTimeAsync(RENEW_INTERVAL_MS * 3);

  expect(allocator.calls.map((call) => call.method)).toEqual(['requestLease']);
  expect(events).toEqual(['publish']);
  expect(recordFor()).toMatchObject({ binding: 'published', release: 'not-requested' });
  expect(await acquire()).toMatchObject({ status: 'unavailable', reason: 'shutting-down' });
});

test('an acquisition abandoned during handoff tears the published device down and releases it', async () => {
  const caller = controller();
  const { allocator, coordinator, events, recordFor, acquire } = await setup(
    { requestLease: [granted()], releaseLease: [undefined] },
    {
      publish: async () => {
        events.push('publish');
        caller.abort();
      },
    },
  );

  expect(await acquire({ signal: caller.signal })).toMatchObject({
    status: 'unavailable',
    reason: 'abandoned',
  });
  expect(events).toEqual(['publish', 'teardown after requestLease']);
  expect(allocator.calls.at(-1)?.method).toBe('releaseLease');
  expect(recordFor()).toMatchObject({ binding: 'cleaned', release: 'released' });
  expect(coordinator.binding(OWNER)).toBeUndefined();
});

test('a published device whose journal write fails is torn down and its lease released', async () => {
  const { allocator, coordinator, events, recordFor, acquire } = await setup(
    { requestLease: [granted()], releaseLease: [undefined] },
    {},
    'binding-published',
  );

  expect(await acquire()).toMatchObject({ status: 'unavailable', reason: 'handoff-failed' });
  expect(events).toEqual(['publish', 'teardown after requestLease']);
  expect(allocator.calls.at(-1)?.method).toBe('releaseLease');
  expect(recordFor()).toMatchObject({ binding: 'cleaned', release: 'released' });
  expect(coordinator.binding(OWNER)).toBeUndefined();
});

test('a lease a previous process left granted is released on restart without a status lookup', async () => {
  const { coordinator, events, recordFor, acquire, restart } = await setup({
    requestLease: [granted()],
  });
  expect((await acquire()).status).toBe('granted');
  await coordinator[Symbol.asyncDispose]();

  const next = await restart({ releaseLease: [undefined] });

  expect(next.allocator.calls.map((call) => call.method)).toEqual(['releaseLease']);
  expect(events).toEqual(['publish']);
  expect(recordFor()).toMatchObject({ binding: 'cleaned', release: 'released' });
});

test('a cancellation a previous process could not confirm is retried on restart', async () => {
  const { coordinator, recordFor, acquire, restart } = await setup({
    requestLease: [pending],
    getLeaseRequestStatus: [pending],
    cancelLeaseRequest: [new Error('allocator unreachable')],
  });
  const acquisition = acquire();
  await vi.advanceTimersByTimeAsync(0);
  await coordinator[Symbol.asyncDispose]();
  expect(await acquisition).toMatchObject({ status: 'unavailable', reason: 'allocator-uncertain' });

  const next = await restart({ cancelLeaseRequest: [cancelled] });

  expect(next.allocator.calls.map((call) => call.method)).toEqual(['cancelLeaseRequest']);
  expect(recordFor().phase.status).toBe('cancelled');
});

test('a release the allocator cannot confirm on restart stays journaled and the coordinator still opens', async () => {
  const { coordinator, recordFor, acquire, restart } = await setup({
    requestLease: [granted()],
  });
  expect((await acquire()).status).toBe('granted');
  await coordinator[Symbol.asyncDispose]();

  const next = await restart({ releaseLease: [new Error('allocator unreachable')] });

  expect(recordFor()).toMatchObject({ binding: 'cleaned', release: 'pending' });
  expect(next.coordinator.binding(OWNER)).toBeUndefined();
});

test('settled operations cost the allocator nothing on restart', async () => {
  const { coordinator, acquire, restart } = await setup({
    requestLease: [granted()],
    releaseLease: [undefined],
  });
  expect((await acquire()).status).toBe('granted');
  await coordinator.release(OWNER);

  const next = await restart({});

  expect(next.allocator.calls).toEqual([]);
});

test('an operation left uncertain for the owner is given back before its next acquisition', async () => {
  const { allocator, coordinator, acquire } = await setup({
    requestLease: [
      new Error('allocator unreachable'),
      granted({ attemptKey: 'attempt-2', requestGeneration: 2 }),
    ],
    getLeaseRequestStatus: [new Error('allocator unreachable')],
    cancelLeaseRequest: [new Error('allocator unreachable'), cancelled],
  });
  const stale = acquire({ deadlineAtMs: NOW + POLL_INTERVAL_MS });
  await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
  expect(await stale).toMatchObject({ status: 'unavailable', reason: 'allocator-uncertain' });

  vi.mocked(crypto.randomUUID).mockReturnValue('attempt-2' as ReturnType<typeof crypto.randomUUID>);
  expect((await acquire()).status).toBe('granted');
  expect(allocator.calls.map((call) => call.method).slice(-2)).toEqual([
    'cancelLeaseRequest',
    'requestLease',
  ]);
  expect(coordinator.binding(OWNER)).toBeDefined();
});
