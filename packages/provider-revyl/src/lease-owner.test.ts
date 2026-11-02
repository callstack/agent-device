import assert from 'node:assert/strict';
import { afterEach, test, vi } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import { buildRevylDevice } from './device.ts';
import { createRevylRuntime } from './runtime.ts';
import { revylLease } from './revyl-backend.fixtures.ts';

const device = buildRevylDevice('ios', revylLease('ios'), 'run-1');
const lease = revylLease('ios');
const startPath = '/api/v1/execution/start_device';
const stopPath = '/api/v1/execution/device/sessions/';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((report) => {
    resolve = report;
  });
  return { promise, resolve };
}

function harness() {
  const start = deferred<Response>();
  const stop = deferred<Response>();
  let creates = 0;
  let stops = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: URL | string) => {
      const path = new URL(input).pathname;
      if (path === startPath) {
        creates++;
        return await start.promise;
      }
      if (path.startsWith(stopPath)) {
        stops++;
        return await stop.promise;
      }
      if (path.includes('worker-connection'))
        return Response.json({ status: 'ready', worker_ws_url: 'wss://test' });
      return Response.json({ device_connected: true });
    }),
  );
  const { runtime } = createRevylRuntime({ apiKey: 'test-key', clientVersion: 'test' });
  return { runtime, start, stop, creates: () => creates, stops: () => stops };
}
const started = () => Response.json({ workflow_run_id: 'run-1' });
const stopped = () => Response.json({ success: true, request_accepted: true });
const retired = (error: unknown) =>
  error instanceof AppError && error.details?.reason === 'provider-lease-releasing';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

test('release immediately retires interactors, inventory and repeat allocation, including after failure', async () => {
  const h = harness();
  h.start.resolve(started());
  await h.runtime.leaseLifecycle!.allocate!(lease);
  assert.ok(h.runtime.getInteractor(device));
  const release = h.runtime.leaseLifecycle!.release!(lease);
  const rejected = release.then(
    () => undefined,
    (error: unknown) => error,
  );
  try {
    assert.equal(h.runtime.hasLiveSession(device), false);
    assert.equal(h.runtime.getInteractor(device), undefined);
    assert.equal(
      await h.runtime.deviceInventoryProvider!({ leaseProvider: 'revyl', leaseId: lease.leaseId }),
      null,
    );
    await assert.rejects(h.runtime.leaseLifecycle!.allocate!(lease), retired);
  } finally {
    h.stop.resolve(Response.json({ success: false }));
    await rejected;
  }
  const error = await rejected;
  assert.ok(error instanceof AppError);
  assert.equal(error.details?.cleanup, 'uncertain');
  assert.equal(h.runtime.getInteractor(device), undefined);
  await assert.rejects(h.runtime.leaseLifecycle!.allocate!(lease), retired);
  assert.equal(h.creates(), 1);
});

test('release before the first allocation await refuses the device it takes', async () => {
  const h = harness();
  const allocation = h.runtime.leaseLifecycle!.allocate!(lease);
  const refused = allocation.then(() => false, retired);
  const disposal = h.runtime.leaseLifecycle!.release!(lease);
  h.start.resolve(started());
  h.stop.resolve(stopped());
  await disposal;
  assert.equal(await refused, true);
  assert.equal(h.runtime.hasLiveSession(device), false);
});

test.each(['release', 'shutdown'] as const)(
  '%s bounds a pending create and ends its late answer exactly once',
  async (by) => {
    const h = harness();
    const allocation = h.runtime.leaseLifecycle!.allocate!(lease);
    const refused = allocation.then(
      () => false,
      (error: unknown) => error instanceof AppError,
    );
    await vi.waitFor(() => assert.equal(h.creates(), 1));
    vi.useFakeTimers();
    const disposal =
      by === 'release' ? h.runtime.leaseLifecycle!.release!(lease) : h.runtime.shutdown();
    let settled = false;
    const observed = disposal
      .then(
        () => undefined,
        (error: unknown) => error,
      )
      .finally(() => {
        settled = true;
      });
    // Cross the 120-second disposal wait without settling the transport's create promise.
    await vi.advanceTimersByTimeAsync(125_000);
    try {
      assert.equal(settled, true, 'disposal must answer within its creation budget');
      const error = await observed;
      assert.ok(error instanceof AppError);
      assert.equal(error.details?.cleanup, 'uncertain');
    } finally {
      h.start.resolve(started());
      h.stop.resolve(stopped());
      await observed;
      await refused;
    }
    assert.equal(await refused, true);
    await vi.waitFor(() => assert.equal(h.stops(), 1));
    await h.runtime.shutdown();
    assert.equal(h.stops(), 1);
    assert.equal(h.creates(), 1);
  },
);

test('an unanswered stop reports uncertainty, joins the pending stop, and accepts its late confirmation', async () => {
  const h = harness();
  h.start.resolve(started());
  await h.runtime.leaseLifecycle!.allocate!(lease);
  vi.useFakeTimers();
  let settled = false;
  const release = h.runtime.leaseLifecycle!.release!(lease);
  const observed = release
    .then(
      () => undefined,
      (error: unknown) => error,
    )
    .finally(() => {
      settled = true;
    });
  // Cross the 30-second disposal wait while the stop's transport promise remains pending.
  await vi.advanceTimersByTimeAsync(35_000);
  try {
    assert.equal(settled, true, 'release must bound an unanswered stop');
    const error = await observed;
    assert.ok(error instanceof AppError);
    assert.equal(error.details?.cleanup, 'uncertain');
  } finally {
    h.stop.resolve(stopped());
    await observed;
  }
  await h.runtime.leaseLifecycle!.release!(lease);
  assert.equal(h.stops(), 1);
});
