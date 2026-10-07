import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { startManagedLeaseKeepalive } from '../lease-keepalive.ts';
import {
  NOW,
  controller,
  deferred,
  granted,
  horizon,
  renewedLease,
  setupAdmission,
} from './lease-admission.fixtures.ts';

const INTERVAL_MS = 30_000;
const TEARDOWN_MS = 5_000;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => vi.useRealTimers());

function keepaliveFor(script: NonNullable<Parameters<typeof setupAdmission>[0]>['script']) {
  const setup = setupAdmission({
    grant: granted({ lease: renewedLease({ ttlDeadline: NOW + 40_000 }) }),
    script,
  });
  const onLost = vi.fn();
  const keepalive = startManagedLeaseKeepalive({
    admission: setup.admission,
    intervalMs: INTERVAL_MS,
    teardownTimeoutMs: TEARDOWN_MS,
    onLost,
  });
  return { ...setup, onLost, keepalive };
}

test('renews between commands once the lease no longer covers the next interval and teardown', async () => {
  const { allocator, onLost, keepalive } = keepaliveFor({
    renewLease: [
      renewedLease({ ttlDeadline: NOW + 70_000 }),
      renewedLease({ ttlDeadline: NOW + 100_000 }),
    ],
  });

  // The granted lease already covers the first interval plus teardown.
  await vi.advanceTimersByTimeAsync(0);
  expect(allocator.calls).toEqual([]);

  await vi.advanceTimersByTimeAsync(INTERVAL_MS);
  expect(allocator.calls).toEqual([
    {
      method: 'renewLease',
      input: { leaseId: 'lease-1', ttlDeadline: NOW + INTERVAL_MS * 2 + TEARDOWN_MS + 5_000 },
    },
  ]);
  await vi.advanceTimersByTimeAsync(INTERVAL_MS);
  expect(allocator.calls).toHaveLength(2);
  expect(onLost).not.toHaveBeenCalled();
  keepalive[Symbol.dispose]();
});

test('reports the binding lost when neither renewal nor lookup confirms authority', async () => {
  const { allocator, admission, onLost, keepalive } = keepaliveFor({
    renewLease: [new Error('allocator unreachable')],
    getLeaseRequestStatus: [new Error('allocator unreachable')],
  });

  await vi.advanceTimersByTimeAsync(INTERVAL_MS);

  expect(onLost).toHaveBeenCalledOnce();
  expect(onLost.mock.calls[0]?.[0]).toMatchObject({
    status: 'teardown-required',
    reason: 'authority-unconfirmed',
  });
  // The admission itself is fenced, so no command can start on the lost binding.
  const task = vi.fn(async () => {});
  expect((await admission.run(horizon(), controller().signal, task)).status).toBe(
    'teardown-required',
  );
  expect(task).not.toHaveBeenCalled();
  // Nothing re-arms after a loss.
  await vi.advanceTimersByTimeAsync(INTERVAL_MS * 3);
  expect(allocator.calls).toHaveLength(2);
  keepalive[Symbol.dispose]();
});

test('disposal stops renewal, including a renewal still in flight, without reporting a loss', async () => {
  const pending = deferred<ReturnType<typeof renewedLease>>();
  const { allocator, onLost, keepalive } = keepaliveFor({ renewLease: [pending.promise] });

  await vi.advanceTimersByTimeAsync(INTERVAL_MS);
  expect(allocator.calls).toHaveLength(1);
  keepalive[Symbol.dispose]();
  pending.resolve(renewedLease({ ttlDeadline: NOW + 70_000 }));

  await vi.advanceTimersByTimeAsync(INTERVAL_MS * 3);
  expect(allocator.calls).toHaveLength(1);
  expect(onLost).not.toHaveBeenCalled();
});
