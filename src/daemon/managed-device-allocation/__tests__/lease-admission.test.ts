import { beforeEach, afterEach, expect, test, vi } from 'vitest';
import type {
  LeaseRequestStatus,
  ManagedLease,
} from '@agent-device/contracts/managed-device-allocation';
import {
  NOW,
  controller,
  deferred,
  granted,
  horizon,
  renewedLease,
  setupAdmission,
  unknownStatus,
} from './lease-admission.fixtures.ts';

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => vi.useRealTimers());

test('reuses only an allocator-confirmed horizon outside the safety window', async () => {
  const { admission, allocator } = setupAdmission({ grant: granted() });
  const task = vi.fn(async () => 'value');
  expect(await admission.run(horizon(), controller().signal, task)).toMatchObject({
    status: 'admitted',
    ttlDeadline: NOW + 100_000,
    value: 'value',
  });
  expect(allocator.calls).toEqual([]);
  const near = setupAdmission({
    grant: granted(),
    safetyWindowMs: 100_000,
    script: { renewLease: [renewedLease({ ttlDeadline: NOW + 200_000 })] },
  });
  expect((await near.admission.run(horizon(), controller().signal, task)).status).toBe('admitted');
  expect(near.allocator.calls).toHaveLength(1);
});

test('same-lease waiters share renewal while a different lease proceeds independently', async () => {
  const pending = deferred<ManagedLease>();
  const first = setupAdmission({ script: { renewLease: [pending.promise] } });
  const task = vi.fn(async () => {});
  const a = first.admission.run(horizon(), controller().signal, task);
  const b = first.admission.run(horizon(), controller().signal, task);
  const other = setupAdmission({
    grant: granted({ lease: renewedLease({ id: 'lease-2', ttlDeadline: NOW + 1_000 }) }),
    script: { renewLease: [renewedLease({ id: 'lease-2' })] },
  });
  expect((await other.admission.run(horizon(), controller().signal, async () => {})).status).toBe(
    'admitted',
  );
  expect(first.allocator.calls).toHaveLength(1);
  expect(task).not.toHaveBeenCalled();
  pending.resolve(renewedLease());
  expect((await Promise.all([a, b])).map((result) => result.status)).toEqual([
    'admitted',
    'admitted',
  ]);
});

test('a longer-horizon waiter obtains its own confirmation after joining a shorter renewal', async () => {
  const short = deferred<ManagedLease>();
  const long = deferred<ManagedLease>();
  const { admission, allocator } = setupAdmission({
    script: { renewLease: [short.promise, long.promise] },
  });
  const longTask = vi.fn(async () => {});
  const a = admission.run(horizon(), controller().signal, async () => {});
  const b = admission.run(horizon(200_000), controller().signal, longTask);
  short.resolve(renewedLease());
  expect((await a).status).toBe('admitted');
  expect(longTask).not.toHaveBeenCalled();
  expect(allocator.calls[1]).toEqual({
    method: 'renewLease',
    input: { leaseId: 'lease-1', ttlDeadline: NOW + 210_000 },
  });
  long.resolve(renewedLease({ ttlDeadline: NOW + 205_000 }));
  expect((await b).status).toBe('admitted');
});

test.each([
  { ttlDeadline: NOW - 1 },
  { ttlDeadline: NOW + 14_999 },
  { ttlDeadline: Number.NaN },
  { ttlDeadline: Number.POSITIVE_INFINITY },
  { id: 'wrong' },
  { device: { address: 'wrong' } },
  { environment: { SIMLOCK_IOS_DEVICE_SET: '/foreign' } },
])('invalid renewal %j never becomes local authority', async (overrides) => {
  const { admission, allocator } = setupAdmission({
    script: { renewLease: [renewedLease(overrides)], getLeaseRequestStatus: [unknownStatus] },
  });
  const task = vi.fn(async () => {});
  expect(await admission.run(horizon(), controller().signal, task)).toMatchObject({
    status: 'teardown-required',
    reason: 'authority-unconfirmed',
  });
  expect((await admission.run(horizon(), controller().signal, task)).status).toBe(
    'teardown-required',
  );
  expect(task).not.toHaveBeenCalled();
  expect(allocator.calls.map((call) => call.method)).toEqual([
    'renewLease',
    'getLeaseRequestStatus',
  ]);
});

test('a lost renewal response is reconciled through the exact durable attempt', async () => {
  const { admission, allocator } = setupAdmission({
    script: { renewLease: [new Error('lost response')], getLeaseRequestStatus: [granted()] },
  });
  expect(
    await admission.run(horizon(), controller().signal, async () => 'confirmed'),
  ).toMatchObject({ status: 'admitted', ttlDeadline: NOW + 100_000 });
  expect(allocator.calls[1]).toEqual({
    method: 'getLeaseRequestStatus',
    input: { requesterId: 'requester-a', attemptKey: 'attempt-1' },
  });
});

test.each([
  unknownStatus,
  granted({ state: 'cancelled' }),
  granted({ state: 'superseded' }),
  granted({ state: 'pending' }),
  granted({ state: 'refused' }),
  granted({ requesterId: 'other' }),
  granted({ attemptKey: 'other' }),
  granted({ requestGeneration: 2 }),
  granted({ identityIncarnationId: 'other' }),
  granted({ lease: renewedLease({ ttlDeadline: NOW + 14_999 }) }),
  new Error('lookup unavailable'),
])('unconfirmed lookup %j requires canonical teardown', async (status) => {
  const { admission } = setupAdmission({
    script: { renewLease: [new Error('renewal failed')], getLeaseRequestStatus: [status] },
  });
  const task = vi.fn(async () => {});
  expect((await admission.run(horizon(), controller().signal, task)).status).toBe(
    'teardown-required',
  );
  expect(task).not.toHaveBeenCalled();
});

test('abort abandons one caller and does not cancel renewal or another waiter', async () => {
  const pending = deferred<ManagedLease>();
  const { admission, allocator } = setupAdmission({ script: { renewLease: [pending.promise] } });
  const abort = controller();
  const task = vi.fn(async () => {});
  const a = admission.run(horizon(), abort.signal, task);
  const b = admission.run(horizon(), controller().signal, async () => {});
  abort.abort();
  expect(await a).toEqual({ status: 'abandoned' });
  pending.resolve(renewedLease());
  expect((await b).status).toBe('admitted');
  expect(task).not.toHaveBeenCalled();
  expect(allocator.calls).toHaveLength(1);
});

test('caller deadline ends the wait while a late renewal can still confirm authority', async () => {
  const pending = deferred<ManagedLease>();
  const { admission, allocator } = setupAdmission({ script: { renewLease: [pending.promise] } });
  const a = admission.run(horizon(), controller().signal, async () => {
    throw new Error('expired operation');
  });
  await vi.advanceTimersByTimeAsync(10_000);
  expect(await a).toEqual({ status: 'deadline-exceeded' });
  pending.resolve(renewedLease());
  expect((await admission.run(horizon(), controller().signal, async () => {})).status).toBe(
    'admitted',
  );
  expect(allocator.calls).toHaveLength(1);
});

test.each(['released', 'replaced', 'superseded', 'fenced'] as const)(
  '%s binding cannot be revived by a late renewal or lookup',
  async (reason) => {
    for (const recovering of [false, true]) {
      const pending = deferred<ManagedLease | LeaseRequestStatus>();
      const script = recovering
        ? { renewLease: [new Error('lost')], getLeaseRequestStatus: [pending.promise] }
        : { renewLease: [pending.promise] };
      const { admission, allocator } = setupAdmission({ script });
      const task = vi.fn(async () => {});
      const a = admission.run(horizon(), controller().signal, task);
      if (recovering) await vi.waitFor(() => expect(allocator.calls).toHaveLength(2));
      admission.fenceBinding(reason);
      pending.resolve(recovering ? granted() : renewedLease());
      expect(await a).toMatchObject({ status: 'teardown-required', reason });
      expect((await admission.run(horizon(), controller().signal, task)).status).toBe(
        'teardown-required',
      );
      expect(task).not.toHaveBeenCalled();
    }
  },
);

test('an already aborted caller starts no allocator work and an operation failure stays primary', async () => {
  const abort = controller();
  abort.abort();
  const { admission, allocator } = setupAdmission({ grant: granted() });
  expect(await admission.run(horizon(), abort.signal, async () => {})).toEqual({
    status: 'abandoned',
  });
  const failure = new Error('operation failed');
  await expect(
    admission.run(horizon(), controller().signal, async () => {
      throw failure;
    }),
  ).rejects.toBe(failure);
  expect(allocator.calls).toEqual([]);
});

test('fencing wakes a waiter even when durable renewal never responds', async () => {
  const { admission } = setupAdmission({
    script: { renewLease: [deferred<ManagedLease>().promise] },
  });
  const waiter = admission.run(horizon(), controller().signal, async () => {
    throw new Error('fenced operation');
  });
  admission.fenceBinding('released');
  expect(await waiter).toEqual({ status: 'teardown-required', reason: 'released' });
});
