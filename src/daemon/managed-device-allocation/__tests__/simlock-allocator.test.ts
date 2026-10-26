import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { LeaseRequestInput } from '@agent-device/contracts/managed-device-allocation';
import {
  createSimlockManagedDeviceAllocator,
  type SimlockLeaseClient,
} from '../simlock-allocator.ts';

const NOW = 1_800_000_000_000;
const REF = { requesterId: 'job-1', requestGeneration: 1, attemptKey: 'attempt-1' };
const INPUT: LeaseRequestInput = {
  ...REF,
  shape: { platform: 'ios', deviceType: 'iPhone 16', osVersion: '18' },
  deadlineAtMs: NOW + 60_000,
  admission: 'fail-fast',
};
const GRANT = {
  device: { id: 'dev-1', driverDeviceId: 'UDID-1' },
  environment: { SIMLOCK_IOS_DEVICE_SET: '/simlock/devices' },
  lease: { id: 'lease-1', ttlDeadline: NOW + 900_000 },
};
const LISTED = { ...GRANT.lease, requesterId: 'job-1' };

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

function simlockError(code: string): Error {
  return Object.assign(new Error(`simlock ${code}`), { code });
}

function setup(overrides: Partial<SimlockLeaseClient> = {}) {
  const client = {
    requestLease: vi.fn(async () => GRANT),
    cancelLease: vi.fn(async () => ({ result: 'cancelled' as const })),
    renewLease: vi.fn(async ({ leaseId, ttlMs }) => ({ id: leaseId, ttlDeadline: NOW + ttlMs })),
    releaseLease: vi.fn(async ({ leaseId }) => ({ leaseId })),
    listLeases: vi.fn(async () => ({ leases: [LISTED] })),
    ...overrides,
  } satisfies SimlockLeaseClient;
  return {
    client,
    allocator: createSimlockManagedDeviceAllocator({ instanceId: 'simlock', client }),
  };
}

test('a grant requests the shape fail-fast under the attempt key and maps the device', async () => {
  const { client, allocator } = setup();

  expect(await allocator.requestLease(INPUT)).toEqual({
    ...REF,
    requestGeneration: 1,
    state: 'granted',
    identityIncarnationId: 'dev-1',
    lease: {
      id: 'lease-1',
      ttlDeadline: NOW + 900_000,
      device: { address: 'UDID-1' },
      environment: { SIMLOCK_IOS_DEVICE_SET: '/simlock/devices' },
    },
  });
  expect(client.requestLease).toHaveBeenCalledWith({
    platform: 'ios',
    model: 'iPhone 16',
    osVersion: '18',
    requesterId: 'job-1',
    idempotencyKey: 'attempt-1',
    noWait: true,
    timeoutMs: 60_000,
  });
});

test('a Simlock admission error is a terminal refusal', async () => {
  const { allocator } = setup({
    requestLease: vi.fn(async () => {
      throw simlockError('NO_CAPACITY');
    }),
  });

  expect(await allocator.requestLease(INPUT)).toMatchObject({
    state: 'refused',
    refusal: { reason: 'simulator-capacity' },
  });
});

test('a transport failure is rethrown and leaves the attempt unknown', async () => {
  const lost = simlockError('DAEMON_CONNECTION_LOST');
  const { allocator } = setup({
    requestLease: vi.fn(async () => {
      throw lost;
    }),
  });

  await expect(allocator.requestLease(INPUT)).rejects.toBe(lost);
  expect(await allocator.getLeaseRequestStatus(REF)).toMatchObject({ state: 'unknown' });
});

test('an abandoned wait reports pending and lookup later sees the grant without a replay', async () => {
  let resolveGrant: (grant: typeof GRANT) => void = () => {};
  const { client, allocator } = setup({
    requestLease: vi.fn(() => new Promise<typeof GRANT>((resolve) => (resolveGrant = resolve))),
  });
  const wait = new AbortController();

  const request = allocator.requestLease({ ...INPUT, signal: wait.signal });
  wait.abort();
  expect(await request).toMatchObject({ state: 'pending' });
  expect(client.cancelLease).not.toHaveBeenCalled();

  resolveGrant(GRANT);
  await vi.advanceTimersByTimeAsync(0);
  expect(await allocator.getLeaseRequestStatus(REF)).toMatchObject({ state: 'granted' });
  expect(client.requestLease).toHaveBeenCalledTimes(1);
});

test('an attempt this daemon did not start is unknown and never replayed', async () => {
  const { client, allocator } = setup();

  await expect(allocator.getLeaseRequestStatus(REF)).rejects.toMatchObject({
    details: { reason: 'simlock-attempt-unknown' },
  });
  expect(client.requestLease).not.toHaveBeenCalled();
});

test('a grant whose lease Simlock no longer lists confirms no authority', async () => {
  const { allocator } = setup({ listLeases: vi.fn(async () => ({ leases: [] })) });
  await allocator.requestLease(INPUT);

  const status = await allocator.getLeaseRequestStatus(REF);
  expect(status).toEqual({ ...REF, state: 'unknown' });
});

test('cancelling a pending attempt cancels the requester and reports the cancellation', async () => {
  let rejectGrant: (error: Error) => void = () => {};
  const { client, allocator } = setup({
    requestLease: vi.fn(() => new Promise<typeof GRANT>((_, reject) => (rejectGrant = reject))),
    cancelLease: vi.fn(async () => {
      rejectGrant(simlockError('CANCELLED'));
      return { result: 'cancelled' as const };
    }),
  });
  const wait = new AbortController();
  const request = allocator.requestLease({ ...INPUT, signal: wait.signal });
  wait.abort();
  await request;

  expect(await allocator.cancelLeaseRequest(REF)).toMatchObject({ state: 'cancelled' });
  expect(client.cancelLease).toHaveBeenCalledWith({ requesterId: 'job-1' });
});

test('renewal asks Simlock for the remaining width and returns the confirmed deadline', async () => {
  const { client, allocator } = setup();
  await allocator.requestLease(INPUT);

  const lease = await allocator.renewLease({ leaseId: 'lease-1', ttlDeadline: NOW + 1_200_000 });
  expect(client.renewLease).toHaveBeenCalledWith({ leaseId: 'lease-1', ttlMs: 1_200_000 });
  expect(lease).toMatchObject({ id: 'lease-1', ttlDeadline: NOW + 1_200_000 });
});

test('releasing a lease Simlock already ended succeeds', async () => {
  const { allocator } = setup({
    releaseLease: vi.fn(async () => {
      throw simlockError('UNKNOWN_LEASE');
    }),
  });

  await expect(allocator.releaseLease({ leaseId: 'lease-1' })).resolves.toBeUndefined();
});

test.each([
  ['a queued request', 'cancelled', [LISTED], 'cancelled'],
  ['a requester with no request and no lease', 'not-found', [], 'cancelled'],
  ['a requester whose request may already be granted', 'not-found', [LISTED], 'unknown'],
  ['device work already in flight', 'not-cancellable', [], 'unknown'],
] as const)(
  'cancelling an attempt this daemon did not start: %s',
  async (_, result, leases, state) => {
    const { client, allocator } = setup({
      cancelLease: vi.fn(async () => ({ result })),
      listLeases: vi.fn(async () => ({ leases })),
    });

    expect(await allocator.cancelLeaseRequest(REF)).toEqual({ ...REF, state });
    expect(client.cancelLease).toHaveBeenCalledWith({ requesterId: 'job-1' });
    expect(client.requestLease).not.toHaveBeenCalled();
  },
);
