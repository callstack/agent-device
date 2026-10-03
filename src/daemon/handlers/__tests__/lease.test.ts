import assert from 'node:assert/strict';
import { test } from 'vitest';
import { handleLeaseCommands } from '../lease.ts';
import { LeaseRegistry } from '../../lease-registry.ts';
import type { DaemonRequest } from '../../daemon-request.ts';
import { makeSessionStore } from '../../../__tests__/test-utils/store-factory.ts';
import type { DeviceLease } from '@agent-device/contracts/device';
import { AppError } from '@agent-device/kernel/errors';
import { clearRequestCanceled, markRequestCanceled } from '@agent-device/host-kit/request';
import {
  HUMAN_CONTROL_LEASE_REQUEST,
  HUMAN_CONTROL_SCOPE,
  createControlLatch,
  humanControlRequest,
} from '../../__tests__/human-control-fixtures.ts';

for (const operation of ['allocate', 'release'] as const) {
  test(`host activation drains provider lease ${operation} before reporting active`, async () => {
    const registry = new LeaseRegistry();
    const lease = registry.allocateLease(HUMAN_CONTROL_LEASE_REQUEST);
    const started = createControlLatch();
    const finish = createControlLatch();
    const request = humanControlRequest(lease, `lease_${operation}`, []);
    const mutation = handleLeaseCommands({
      req: request,
      sessionName: request.session,
      sessionStore: makeSessionStore('agent-device-held-provider-'),
      leaseRegistry: registry,
      leaseLifecycleProvider: {
        [operation]: async () => {
          started.resolve();
          await finish.promise;
          return {};
        },
      },
    });
    await started.promise;
    let active = false;
    const activation = registry
      .putHumanControlHold({ kind: 'host' }, 'host', { scope: HUMAN_CONTROL_SCOPE })
      .then(() => {
        active = true;
      });
    await Promise.resolve();
    assert.equal(active, false);
    finish.resolve();
    assert.equal((await mutation)?.ok, true);
    await activation;
    assert.equal(active, true);
  });
}

test('activation drains canceled provider allocation and its release cleanup', async () => {
  const registry = new LeaseRegistry();
  const lease = registry.allocateLease(HUMAN_CONTROL_LEASE_REQUEST);
  const started = createControlLatch();
  const finish = createControlLatch();
  const request = humanControlRequest(lease, 'lease_allocate', []);
  const requestId = 'held-canceled-allocation';
  request.meta = { ...request.meta, requestId };
  let providerReleased = false;
  const mutation = handleLeaseCommands({
    req: request,
    sessionName: request.session,
    sessionStore: makeSessionStore('agent-device-held-canceled-provider-'),
    leaseRegistry: registry,
    leaseLifecycleProvider: {
      allocate: async () => {
        started.resolve();
        await finish.promise;
        markRequestCanceled(requestId);
        return {};
      },
      release: async () => {
        assert.equal(registry.listHumanControlHolds({ kind: 'host' })[0]?.state, 'activating');
        providerReleased = true;
        return {};
      },
    },
  });
  await started.promise;
  const activation = registry.putHumanControlHold({ kind: 'host' }, 'host', {
    scope: HUMAN_CONTROL_SCOPE,
  });
  finish.resolve();
  try {
    await assert.rejects(
      mutation,
      (error: unknown) => error instanceof AppError && error.details?.released === true,
    );
    await activation;
    assert.equal(providerReleased, true);
    assert.equal(registry.listActiveLeases().length, 0);
  } finally {
    clearRequestCanceled(requestId);
  }
});

function allocateRequest(): DaemonRequest {
  return {
    token: 'test-token',
    session: 'lease-ttl-test',
    command: 'lease_allocate',
    positionals: [],
    flags: {},
    meta: {
      tenantId: 'tenant-a',
      runId: 'run-a',
      clientId: 'client-a',
      leaseBackend: 'android-instance',
      leaseProvider: 'cloud',
    },
  };
}

// A hosted provider can spend longer creating its session than the lease's inactivity
// TTL. Stamping the TTL when the registry record is created handed the client a lease
// that was already expired, and the paid session behind it was orphaned.
test('a lease whose provider allocation outlasts its TTL is active when allocation returns', async () => {
  let now = 0;
  const registry = new LeaseRegistry({ now: () => now, defaultLeaseTtlMs: 60_000 });
  const response = await handleLeaseCommands({
    req: allocateRequest(),
    sessionName: 'lease-ttl-test',
    sessionStore: makeSessionStore('agent-device-slow-provider-'),
    leaseRegistry: registry,
    leaseLifecycleProvider: {
      allocate: async (lease) => {
        now = 80_000;
        assert.deepEqual(
          registry.consumeExpiredLeases(),
          [],
          'the sweeper must not reap a lease mid-allocation',
        );
        now = 90_000;
        return { providerSessionId: `session-${lease.leaseId}` };
      },
    },
  });

  assert.equal(response?.ok, true);
  const lease = (response?.ok ? response.data?.lease : undefined) as DeviceLease;
  assert.equal(lease.expiresAt, 150_000);
  assert.deepEqual(
    registry.listActiveLeases().map((entry) => [entry.leaseId, entry.expiresAt]),
    [[lease.leaseId, 150_000]],
  );
  now = 149_999;
  registry.assertLeaseAdmission({
    leaseId: lease.leaseId,
    tenantId: lease.tenantId,
    runId: lease.runId,
    leaseBackend: lease.backend,
    leaseProvider: lease.leaseProvider,
  });
});

test('a lease allocated without a provider keeps the TTL it was created with', async () => {
  let now = 5_000;
  const registry = new LeaseRegistry({
    now: () => (now += 1_000),
    defaultLeaseTtlMs: 60_000,
  });
  const response = await handleLeaseCommands({
    req: allocateRequest(),
    sessionName: 'lease-ttl-test',
    sessionStore: makeSessionStore('agent-device-no-provider-'),
    leaseRegistry: registry,
  });

  assert.equal(response?.ok, true);
  const lease = (response?.ok ? response.data?.lease : undefined) as DeviceLease;
  assert.ok(now > lease.createdAt, 'the clock advanced while the lease was allocated');
  assert.equal(lease.heartbeatAt, lease.createdAt);
  assert.equal(lease.expiresAt, lease.createdAt + 60_000);
  assert.deepEqual(registry.listActiveLeases(), [lease]);
});
