import type { DaemonResponse } from '@agent-device/kernel/contracts';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { skipWhenLoopbackUnavailable } from '@agent-device/test-kit';
import { startDaemon, type RpcBody } from './http-server-session-lease-touch.fixtures.ts';

let world: Awaited<ReturnType<typeof startDaemon>> | undefined;

beforeEach(async (context) => {
  if (await skipWhenLoopbackUnavailable(context)) return;
  world = await startDaemon();
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  await world?.close();
  world = undefined;
});

function expectLeaseIdRefusal(body: RpcBody): void {
  expect(body.error?.data).toMatchObject({
    code: 'UNAUTHORIZED',
    details: { reason: 'LEASE_SESSION_MISMATCH', field: 'leaseId' },
  });
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test.each(['sweep', 'close'] as const)(
  '%s wins expiry admission and two owners close with one teardown and one receipt',
  async (first) => {
    const daemon = world;
    if (!daemon) return;
    const ref = daemon.publishLeasedSession(daemon.sessionName);
    const teardown = holdExpiry(daemon);
    daemon.passLeaseDeadline();

    if (first === 'sweep') daemon.leaseRegistry.consumeExpiredLeases();
    const firstClose = daemon.send('close', [], daemon.owner);
    try {
      await teardown.entered.promise;
      const secondJoined = observeNextExpiryWait(daemon);
      const secondClose = daemon.send('close', [], daemon.owner);
      await secondJoined;
      daemon.leaseRegistry.consumeExpiredLeases();
      teardown.release.resolve();

      const responses = await Promise.all([firstClose, secondClose]);
      for (const response of responses)
        expect(response.error?.data?.details?.reason).toBe('LEASE_NOT_FOUND');
      expect(
        responses.flatMap((response) => response.error?.data?.details?.endedLeases ?? []),
      ).toEqual([{ leaseId: daemon.leaseId, outcome: 'released' }]);
      expect(daemon.expiryTeardown).toHaveBeenCalledExactlyOnceWith(ref);
      expect(daemon.sessionStore.get(daemon.sessionName)).toBeUndefined();
    } finally {
      teardown.release.resolve();
      await firstClose;
    }
  },
);

test.each([undefined, 30_000])(
  'two successors share one teardown with waitMs=%s and only one publishes',
  async (waitMs) => {
    const daemon = world;
    if (!daemon) return;
    const ref = daemon.publishLeasedSession(daemon.sessionName);
    const a = daemon.allocateOtherClient('ios:mobile:SIM-002');
    const b = daemon.allocateOtherClient('ios:mobile:SIM-003');
    const teardown = holdExpiry(daemon);
    daemon.passLeaseDeadline();
    const first = daemon.send('open', ['com.example.app'], a);
    try {
      await Promise.race([
        teardown.entered.promise,
        first.then((response) => {
          throw new Error(`First open finished before teardown ${JSON.stringify(response)}`);
        }),
      ]);
      const joined = observeNextExpiryWait(daemon);
      const second = daemon.send('open', ['com.example.app'], b, { flags: { waitMs } });
      await Promise.race([
        joined,
        second.then((response) => {
          throw new Error(`Second open finished before joining ${JSON.stringify(response)}`);
        }),
      ]);
      const closeJoined = observeNextExpiryWait(daemon);
      const close = daemon.send('close', [], daemon.owner);
      await closeJoined;
      teardown.release.resolve();
      const [responses, closed] = await Promise.all([Promise.all([first, second]), close]);
      expect(closed.error?.data?.details).toMatchObject({
        reason: 'LEASE_NOT_FOUND',
        endedLeases: [{ leaseId: daemon.leaseId, outcome: 'released' }],
      });

      expect(
        responses.filter((response) => response.result?.ok),
        JSON.stringify(responses),
      ).toHaveLength(1);
      expectLeaseIdRefusal(responses.find((response) => response.error)!);
      expect(
        responses.every((response) => !JSON.stringify(response).includes(daemon.leaseId)),
      ).toBe(true);
      expect(daemon.expiryTeardown).toHaveBeenCalledExactlyOnceWith(ref);
      expect(daemon.sessionStore.lookup(daemon.sessionName)?.lifetime).not.toBe(ref.lifetime);
    } finally {
      teardown.release.resolve();
      await first;
    }
  },
);

test('open --wait can run out while the daemon is still tearing down the expired session', async () => {
  const daemon = world;
  if (!daemon) return;
  const ref = daemon.publishLeasedSession(daemon.sessionName);
  const successor = daemon.allocateOtherClient('ios:mobile:SIM-002');
  const teardown = holdExpiry(daemon);
  daemon.passLeaseDeadline();
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
  const open = daemon.send('open', ['com.example.app'], successor, { flags: { waitMs: 500 } });
  try {
    await teardown.entered.promise;
    await vi.advanceTimersByTimeAsync(500);
    const response = await open;
    expect(response.error?.data).toMatchObject({
      code: 'DEVICE_IN_USE',
      details: { reason: 'DEVICE_LEASE_BUSY' },
    });
    expect(daemon.sessionStore.lookup(daemon.sessionName)?.lifetime).toBe(ref.lifetime);
  } finally {
    teardown.release.resolve();
    vi.useRealTimers();
    await daemon.expiryOwnerSettled();
    await open;
  }
  expect(daemon.expiryTeardown).toHaveBeenCalledTimes(1);
  expect(daemon.sessionStore.lookup(daemon.sessionName)).toBeUndefined();
});

test.each(['close', 'open'] as const)(
  'disconnecting an expired-session %s cancels the caller and leaves teardown running',
  async (command) => {
    const daemon = world;
    if (!daemon) return;
    const ref = daemon.publishLeasedSession(daemon.sessionName);
    const successor = daemon.allocateOtherClient('ios:mobile:SIM-002');
    const teardown = holdExpiry(daemon);
    const controller = new AbortController();
    const completed = new Promise<DaemonResponse>((resolve) => {
      daemon.hooks.afterRequest = resolve;
    });
    daemon.passLeaseDeadline();
    const pending = expect(
      daemon.send(
        command,
        command === 'open' ? ['com.example.app'] : [],
        command === 'open' ? successor : daemon.owner,
        { signal: controller.signal },
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });

    try {
      await teardown.entered.promise;
      controller.abort();
      await pending;
      expect(await completed).toMatchObject({
        ok: false,
        error: { details: { reason: 'request_canceled' } },
      });
      expect(daemon.sessionStore.lookup(daemon.sessionName)?.lifetime).toBe(ref.lifetime);
    } finally {
      teardown.release.resolve();
    }
    await daemon.expiryOwnerSettled();
    expect(daemon.expiryTeardown).toHaveBeenCalledTimes(1);
    expect(daemon.sessionStore.lookup(daemon.sessionName)).toBeUndefined();
    expect(daemon.runtime.bind).not.toHaveBeenCalled();
  },
);

function holdExpiry(daemon: Awaited<ReturnType<typeof startDaemon>>) {
  const entered = deferred();
  const release = deferred();
  daemon.expiryTeardown.mockImplementationOnce(async () => {
    entered.resolve();
    await release.promise;
  });
  return { entered, release };
}

function observeNextExpiryWait(daemon: Awaited<ReturnType<typeof startDaemon>>): Promise<void> {
  const joined = deferred();
  const lookup = daemon.settlementFor.getMockImplementation()!;
  daemon.settlementFor.mockImplementationOnce((lifetime) => {
    const settlement = lookup(lifetime);
    if (settlement) joined.resolve();
    return settlement;
  });
  return joined.promise;
}

test('a pending hold protects expiry while a mutation drains and restarts the TTL on release', async () => {
  const daemon = world;
  if (!daemon) return;
  const ref = daemon.publishLeasedSession(daemon.sessionName);
  const registry = daemon.leaseRegistry;
  const lease = registry.inspectActiveLease(daemon.leaseId)!;
  const authority = { kind: 'lease', leaseId: daemon.leaseId } as const;
  const drain = deferred();
  const mutation = registry.runDeviceMutation(lease, () => drain.promise);
  const hold = registry.putHumanControlHold(authority, 'console', {});
  try {
    daemon.passLeaseDeadline();
    expect(registry.listHumanControlHolds(authority)[0]?.state).toBe('activating');
    expect(registry.consumeExpiredLeases()).toEqual([]);
    expect(daemon.expiryTeardown).not.toHaveBeenCalled();
  } finally {
    drain.resolve();
  }
  await mutation;
  expect((await hold).state).toBe('active');
  daemon.passLeaseDeadline();
  registry.removeHumanControlHold(authority, 'console');
  expect(registry.consumeExpiredLeases()).toEqual([]);
  expect((await daemon.send('snapshot', [], daemon.owner)).result?.ok).toBe(true);

  daemon.passLeaseDeadline();
  registry.consumeExpiredLeases();
  await daemon.expiryOwnerSettled();
  expect(daemon.expiryTeardown).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ lifetime: ref.lifetime }),
  );
});

test('expiry at a batch step unwinds outer locks and preserves completed progress', async () => {
  const daemon = world;
  if (!daemon) return;
  const ref = daemon.publishLeasedSession(daemon.sessionName);
  const retain = daemon.leaseRegistry.retainLeaseWork.bind(daemon.leaseRegistry);
  vi.spyOn(daemon.leaseRegistry, 'retainLeaseWork').mockImplementationOnce((lease) =>
    retain(lease, () => false),
  );
  let dispatches = 0;
  daemon.hooks.beforeDispatch = () => {
    if (++dispatches === 2) daemon.passLeaseDeadline();
  };

  const response = await daemon.send('batch', [], daemon.owner, {
    flags: { batchSteps: [{ command: 'devices' }, { command: 'snapshot' }] },
  });

  expect(response.error?.data).toMatchObject({
    code: 'UNAUTHORIZED',
    details: {
      reason: 'LEASE_NOT_FOUND',
      step: 2,
      executed: 1,
      partialResults: [{ command: 'devices', ok: true }],
    },
  });
  await daemon.expiryOwnerSettled();
  expect(daemon.expiryTeardown).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ lifetime: ref.lifetime }),
  );
  expect(daemon.sessionStore.get(daemon.sessionName)).toBeUndefined();
});
