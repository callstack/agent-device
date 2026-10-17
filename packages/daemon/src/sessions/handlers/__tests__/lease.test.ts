import assert from 'node:assert/strict';
import { test } from 'vitest';
import { handleLeaseCommands } from '../lease.ts';
import { LeaseRegistry } from '../../../resources/lease-registry.ts';
import type { DaemonRequest } from '../../../core/daemon-request.ts';
import { makeSessionStore } from '../../../__tests__/support/store-factory.ts';
import type { DeviceLease } from '@agent-device/contracts/device';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { withTestDeviceInventory } from '@agent-device/device-selection/inventory-gateways-fixtures';
import { IOS_SIMULATOR, TVOS_SIMULATOR } from '@agent-device/test-kit';
import { AppError } from '@agent-device/kernel/errors';
import {
  clearRequestCanceled,
  markRequestCanceled,
  registerRequestAbort,
} from '@agent-device/host-kit/request';
import {
  HUMAN_CONTROL_LEASE_REQUEST,
  HUMAN_CONTROL_SCOPE,
  createControlLatch,
  humanControlRequest,
} from '../../../__tests__/support/human-control-fixtures.ts';

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

test('lease_allocate answers with the lease id the request named', async () => {
  const registry = new LeaseRegistry();
  const leaseId = 'abcdef0123456789abcdef0123456789';
  const response = await handleLeaseCommands({
    req: {
      token: 'test-token',
      session: 'default',
      command: 'lease_allocate',
      positionals: [],
      meta: { tenantId: 'tenant-a', runId: 'run-1', leaseId },
    },
    sessionName: 'default',
    sessionStore: makeSessionStore('agent-device-chosen-lease-id-'),
    leaseRegistry: registry,
  });
  assert.ok(response?.ok);
  assert.equal((response.data?.lease as DeviceLease | undefined)?.leaseId, leaseId);
  assert.equal(registry.listActiveLeases()[0]?.leaseId, leaseId);
});

test('lease_release still releases a retainOnClose lease through the provider', async () => {
  const registry = new LeaseRegistry();
  const lease = registry.allocateLease({
    tenantId: 'tenant-a',
    runId: 'run-1',
    clientId: 'client-a',
    retainOnClose: true,
  });
  const released: DeviceLease[] = [];
  const request: DaemonRequest = {
    token: 'test-token',
    session: 'default',
    command: 'lease_release',
    positionals: [],
    meta: { tenantId: 'tenant-a', runId: 'run-1', leaseId: lease.leaseId, clientId: 'client-a' },
  };

  const response = await handleLeaseCommands({
    req: request,
    sessionName: 'default',
    sessionStore: makeSessionStore('agent-device-retained-release-'),
    leaseRegistry: registry,
    leaseLifecycleProvider: {
      release: async (active) => {
        released.push(active);
        return { providerSessionId: 'provider-1' };
      },
    },
  });

  assert.equal(response?.ok, true);
  assert.deepEqual(
    released.map((active) => active.leaseId),
    [lease.leaseId],
  );
  assert.equal(registry.listActiveLeases().length, 0);
});

test('lease_release ends the sessions opened under the released lease', async () => {
  const registry = new LeaseRegistry();
  const lease = registry.allocateLease({ tenantId: 'tenant-a', runId: 'run-1' });
  const ended: string[] = [];
  const release = (leaseId: string) =>
    handleLeaseCommands({
      req: {
        token: 'test-token',
        session: 'default',
        command: 'lease_release',
        positionals: [],
        meta: { tenantId: 'tenant-a', runId: 'run-1', leaseId },
      },
      sessionName: 'default',
      sessionStore: makeSessionStore('agent-device-release-ends-session-'),
      leaseRegistry: registry,
      endSessionsForLease: async (id) => {
        ended.push(id);
      },
    });

  assert.equal((await release(lease.leaseId))?.ok, true);
  assert.deepEqual(ended, [lease.leaseId]);
  // A release that releases nothing has no session to end.
  assert.equal((await release(lease.leaseId))?.ok, true);
  assert.deepEqual(ended, [lease.leaseId]);
});

test('lease_release refuses a host-allocated macos-app lease and keeps it', async () => {
  const registry = new LeaseRegistry();
  const lease = registry.putHostLease('a1b2c3d4e5f60718293a4b5c6d7e8f90', {
    tenantId: 'tenant-a',
    runId: 'run-1',
    clientId: 'client-a',
    leaseBackend: 'macos-app' as const,
    deviceKey: 'com.example.app@4242',
  });
  const released: DeviceLease[] = [];
  const meta = {
    tenantId: 'tenant-a',
    runId: 'run-1',
    leaseId: lease.leaseId,
    clientId: 'client-a',
    leaseBackend: 'macos-app' as const,
    deviceKey: 'com.example.app@4242',
  };
  const run = (command: 'lease_release' | 'lease_heartbeat') =>
    handleLeaseCommands({
      req: { token: 'test-token', session: 'default', command, positionals: [], meta },
      sessionName: 'default',
      sessionStore: makeSessionStore('agent-device-macos-app-release-'),
      leaseRegistry: registry,
      leaseLifecycleProvider: {
        release: async (active) => {
          released.push(active);
          return {};
        },
      },
    });

  await assert.rejects(run('lease_release'), (error: AppError) => {
    assert.equal(error.code, 'UNAUTHORIZED');
    assert.equal(error.details?.reason, 'MACOS_APP_LEASE_HOST_OWNED');
    return true;
  });
  assert.deepEqual(released, []);
  assert.equal(registry.listActiveLeases().length, 1);
  assert.equal((await run('lease_heartbeat'))?.ok, true);
});

test('lease_allocate stores retainOnClose from the request meta', async () => {
  const registry = new LeaseRegistry();
  const request: DaemonRequest = {
    token: 'test-token',
    session: 'default',
    command: 'lease_allocate',
    positionals: [],
    meta: { tenantId: 'tenant-a', runId: 'run-1', leaseRetainOnClose: true },
  };

  const response = await handleLeaseCommands({
    req: request,
    sessionName: 'default',
    sessionStore: makeSessionStore('agent-device-retained-allocate-'),
    leaseRegistry: registry,
  });

  assert.equal(response?.ok, true);
  assert.equal(registry.listActiveLeases()[0]?.retainOnClose, true);
});

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

// The registry hands a run's repeat allocation the lease it already holds. A provider refusing the
// repeat request (a profile field it does not read) must leave that lease and its session alone.
test("a refused repeat allocation keeps the run's live lease", async () => {
  const registry = new LeaseRegistry();
  const sessionStore = makeSessionStore('agent-device-refused-repeat-');
  let calls = 0;
  const allocate = async (req: DaemonRequest) =>
    await handleLeaseCommands({
      req,
      sessionName: 'lease-ttl-test',
      sessionStore,
      leaseRegistry: registry,
      leaseLifecycleProvider: {
        allocate: async () => {
          calls += 1;
          if (calls === 1) return { providerSessionId: 'session-1' };
          throw new AppError('INVALID_ARGS', '--provider-os-version is not supported by Cloud.');
        },
      },
    });

  const first = await allocate(allocateRequest());
  const lease = (first?.ok ? first.data?.lease : undefined) as DeviceLease;
  const repeat = allocateRequest();
  repeat.flags = { providerOsVersion: '18.0' };
  await assert.rejects(
    allocate(repeat),
    (error: unknown) => error instanceof AppError && error.code === 'INVALID_ARGS',
  );
  assert.equal(calls, 2);
  assert.deepEqual(
    registry.listActiveLeases().map((entry) => entry.leaseId),
    [lease.leaseId],
  );
  assert.equal(
    registry.resolveProviderSession({
      provider: lease.leaseProvider,
      providerSessionId: 'session-1',
      tenantId: lease.tenantId,
    })?.leaseId,
    lease.leaseId,
  );
});

// A requester that hangs up during its repeat allocation will never release the lease it reused, so
// the provider rejecting with the cancellation must release that lease and its session.
test('a repeat allocation canceled by its requester releases the reused lease', async () => {
  const registry = new LeaseRegistry();
  const sessionStore = makeSessionStore('agent-device-canceled-repeat-');
  const requestId = 'canceled-repeat-allocation';
  const releasedSessions: unknown[] = [];
  let calls = 0;
  const allocate = async (req: DaemonRequest) =>
    await handleLeaseCommands({
      req,
      sessionName: 'lease-ttl-test',
      sessionStore,
      leaseRegistry: registry,
      leaseLifecycleProvider: {
        allocate: async (_lease, context) => {
          calls += 1;
          if (calls === 1) return { providerSessionId: 'session-1' };
          markRequestCanceled(requestId);
          context?.signal?.throwIfAborted();
          throw new Error('the request signal was not aborted');
        },
        release: async (released) => {
          releasedSessions.push(released.leaseId);
          return { providerSessionId: 'session-1' };
        },
      },
    });

  const first = await allocate(allocateRequest());
  const lease = (first?.ok ? first.data?.lease : undefined) as DeviceLease;
  const repeat = allocateRequest();
  repeat.meta = { ...repeat.meta, requestId };
  const registration = registerRequestAbort(requestId);
  try {
    await assert.rejects(
      allocate(repeat),
      (error: unknown) => error instanceof AppError && error.details?.released === true,
    );
  } finally {
    clearRequestCanceled(requestId, registration);
  }
  assert.equal(calls, 2);
  assert.deepEqual(releasedSessions, [lease.leaseId]);
  assert.deepEqual(registry.listActiveLeases(), []);
});

test('a tenant cannot allocate a macos-app lease', async () => {
  const registry = new LeaseRegistry();
  const request: DaemonRequest = {
    token: 'token',
    session: 'default',
    command: 'lease_allocate',
    positionals: [],
    flags: {},
    meta: {
      tenantId: 'tenant-a',
      runId: 'run-1',
      leaseBackend: 'macos-app',
      leaseProvider: 'proxy',
      clientId: 'client-1',
      deviceKey: 'com.apple.finder',
    },
  };
  await assert.rejects(
    handleLeaseCommands({
      req: request,
      sessionName: request.session,
      sessionStore: makeSessionStore('agent-device-macos-app-allocate-'),
      leaseRegistry: registry,
    }),
    (error: AppError) =>
      error.code === 'UNAUTHORIZED' && error.details?.reason === 'MACOS_APP_LEASE_HOST_ALLOCATED',
  );
  assert.deepEqual(registry.listActiveLeases(), []);
});

const SECOND_IOS_SIMULATOR: DeviceInfo = {
  ...IOS_SIMULATOR,
  id: 'sim-2',
  name: 'iPhone 16',
};

function proxyAllocateRequest(
  flags: DaemonRequest['flags'],
  meta: Partial<NonNullable<DaemonRequest['meta']>> = {},
): DaemonRequest {
  return {
    token: 'token',
    session: 'default',
    command: 'lease_allocate',
    positionals: [],
    flags,
    meta: {
      tenantId: 'tenant-a',
      runId: 'run-1',
      leaseBackend: 'ios-instance',
      leaseProvider: 'proxy',
      clientId: 'client-1',
      ...meta,
    },
  };
}

async function allocateAgainstInventory(
  request: DaemonRequest,
  devices: readonly DeviceInfo[],
  leaseRegistry = new LeaseRegistry(),
): Promise<{ lease: DeviceLease; inventoryReads: number }> {
  let inventoryReads = 0;
  const response = await withTestDeviceInventory(
    {
      local: async () => {
        inventoryReads += 1;
        return devices;
      },
    },
    async () =>
      await handleLeaseCommands({
        req: request,
        sessionName: request.session,
        sessionStore: makeSessionStore('agent-device-proxy-allocate-by-spec-'),
        leaseRegistry,
      }),
  );
  assert.ok(response?.ok);
  const lease = response.data?.lease as DeviceLease | undefined;
  assert.ok(lease);
  return { lease, inventoryReads };
}

test('a proxy allocation that names no device picks one by its selectors and binds its deviceKey', async () => {
  const devices = [SECOND_IOS_SIMULATOR, IOS_SIMULATOR, TVOS_SIMULATOR];

  const byName = await allocateAgainstInventory(
    proxyAllocateRequest({ platform: 'ios', device: 'iPhone 17 Pro' }),
    devices,
  );
  assert.equal(byName.lease.deviceKey, 'ios:mobile:sim-1');

  const byTarget = await allocateAgainstInventory(
    proxyAllocateRequest({ platform: 'ios', target: 'tv' }),
    devices,
  );
  assert.equal(byTarget.lease.deviceKey, 'ios:tv:tv-sim-1');
});

test('a proxy allocation with no matching device fails the way a client-side pick does', async () => {
  await assert.rejects(
    allocateAgainstInventory(proxyAllocateRequest({ platform: 'ios', device: 'Pixel 9' }), [
      IOS_SIMULATOR,
    ]),
    (error: AppError) => error.code === 'DEVICE_NOT_FOUND',
  );
});

test('an allocation that names its device, names no spec, or is not a proxy lease, binds no picked device', async () => {
  const exact = await allocateAgainstInventory(
    proxyAllocateRequest({ platform: 'ios' }, { deviceKey: 'ios:mobile:sim-2' }),
    [IOS_SIMULATOR, SECOND_IOS_SIMULATOR],
  );
  assert.equal(exact.lease.deviceKey, 'ios:mobile:sim-2');
  assert.equal(exact.inventoryReads, 0);

  const local = await allocateAgainstInventory(
    proxyAllocateRequest({ platform: 'ios' }, { leaseProvider: undefined, clientId: undefined }),
    [IOS_SIMULATOR],
  );
  assert.equal(local.lease.deviceKey, undefined);
  assert.equal(local.inventoryReads, 0);

  const unspecified = await allocateAgainstInventory(proxyAllocateRequest({}), [IOS_SIMULATOR]);
  assert.equal(unspecified.lease.deviceKey, undefined);
  assert.equal(unspecified.inventoryReads, 0);
});

test('a proxy allocation retried with its lease id gets its lease back without picking again', async () => {
  const leaseId = 'abcdef0123456789abcdef0123456789';
  const registry = new LeaseRegistry();
  const request = proxyAllocateRequest({ platform: 'ios' }, { leaseId });
  const first = await allocateAgainstInventory(request, [IOS_SIMULATOR], registry);
  assert.equal(first.lease.deviceKey, 'ios:mobile:sim-1');

  const deviceGone = await allocateAgainstInventory(request, [], registry);
  assert.equal(deviceGone.lease.leaseId, leaseId);
  assert.equal(deviceGone.lease.deviceKey, 'ios:mobile:sim-1');
  assert.equal(deviceGone.inventoryReads, 0);

  const otherCandidate = await allocateAgainstInventory(request, [SECOND_IOS_SIMULATOR], registry);
  assert.equal(otherCandidate.lease.leaseId, leaseId);
  assert.equal(otherCandidate.inventoryReads, 0);
  assert.deepEqual(
    registry.listActiveLeases().map((lease) => lease.leaseId),
    [leaseId],
  );
});

test("a proxy allocation naming another owner's lease id still picks and is refused", async () => {
  const leaseId = 'abcdef0123456789abcdef0123456789';
  const registry = new LeaseRegistry();
  await allocateAgainstInventory(
    proxyAllocateRequest({ platform: 'ios' }, { leaseId }),
    [IOS_SIMULATOR],
    registry,
  );
  await assert.rejects(
    allocateAgainstInventory(
      proxyAllocateRequest({ platform: 'ios' }, { leaseId, clientId: 'client-2' }),
      [SECOND_IOS_SIMULATOR],
      registry,
    ),
    (error: AppError) =>
      error.code === 'INVALID_ARGS' && error.details?.reason === 'LEASE_ID_IN_USE',
  );
});

const RUNTIME_LESS_LEASES: readonly (readonly [string, Record<string, string>])[] = [
  ['no provider', {}],
  ['a backend and no provider', { leaseBackend: 'ios-instance' }],
  ['the proxy routing identity', { leaseProvider: 'proxy' }],
  ['the cloud remote profile', { leaseProvider: 'cloud' }],
];

for (const [label, scope] of RUNTIME_LESS_LEASES) {
  test(`lease_allocate keeps a runtime-less logical lease with ${label}`, async () => {
    const registry = new LeaseRegistry();
    const response = await handleLeaseCommands({
      req: {
        token: 'test-token',
        session: 'default',
        command: 'lease_allocate',
        positionals: [],
        meta: { tenantId: 'tenant-a', runId: 'run-1', ...scope },
      },
      sessionName: 'default',
      sessionStore: makeSessionStore('agent-device-logical-lease-'),
      leaseRegistry: registry,
      providerRuntimeIds: ['browserstack'],
    });
    assert.equal(response?.ok, true);
    assert.equal(registry.listActiveLeases().length, 1);
  });
}

test('lease_allocate refuses a provider no registered runtime claims, before recording a lease', async () => {
  const registry = new LeaseRegistry();
  await assert.rejects(
    handleLeaseCommands({
      req: {
        token: 'test-token',
        session: 'default',
        command: 'lease_allocate',
        positionals: [],
        meta: { tenantId: 'tenant-a', runId: 'run-1', leaseProvider: 'testmu' },
      },
      sessionName: 'default',
      sessionStore: makeSessionStore('agent-device-unregistered-provider-'),
      leaseRegistry: registry,
      providerRuntimeIds: ['browserstack'],
    }),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, 'UNSUPPORTED_OPERATION');
      assert.equal(error.details?.reason, 'provider-not-registered');
      assert.equal(error.details?.provider, 'testmu');
      assert.deepEqual(error.details?.registeredProviders, ['browserstack']);
      return true;
    },
  );
  assert.deepEqual(registry.listActiveLeases(), []);
});

test('lease_allocate treats a daemon that reports no provider runtimes as having none registered', async () => {
  await assert.rejects(
    handleLeaseCommands({
      req: {
        token: 'test-token',
        session: 'default',
        command: 'lease_allocate',
        positionals: [],
        meta: { tenantId: 'tenant-a', runId: 'run-1', leaseProvider: 'browserstack' },
      },
      sessionName: 'default',
      sessionStore: makeSessionStore('agent-device-no-runtimes-'),
      leaseRegistry: new LeaseRegistry(),
    }),
    (error: unknown) =>
      error instanceof AppError && error.details?.registeredProviders !== undefined,
  );
});
