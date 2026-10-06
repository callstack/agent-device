import assert from 'node:assert/strict';
import { test } from 'vitest';
import { handleLeaseCommands } from '../lease.ts';
import { LeaseRegistry } from '../../lease-registry.ts';
import type { DaemonRequest } from '../../daemon-request.ts';
import { makeSessionStore } from '../../../__tests__/test-utils/store-factory.ts';
import type { DeviceLease } from '@agent-device/contracts/device';
import { AppError } from '@agent-device/kernel/errors';
import {
  clearRequestCanceled,
  markRequestCanceled,
  registerRequestAbort,
} from '@agent-device/host-kit/request';
import {
  providerCredentialFingerprint,
  readDaemonProviderCredentials,
} from '../../../provider-credential-fingerprint.ts';
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

const LIMRUN_ATTACH_ENV = {
  LIMRUN_API_KEY: 'lim-key',
  LIM_IOS_INSTANCE_URL: 'https://region.limrun.example/v1/ios_x/api',
  LIM_IOS_INSTANCE_TOKEN: 'ios-token',
};
const BROWSERSTACK_ENV = { BROWSERSTACK_USERNAME: 'user', BROWSERSTACK_ACCESS_KEY: 'key-1' };

function providerAllocateRequest(
  leaseProvider: string,
  providerCredentialFingerprint: string | undefined,
  leaseBackend: 'ios-instance' | 'android-instance' = 'ios-instance',
): DaemonRequest {
  const request = allocateRequest();
  return {
    ...request,
    meta: {
      ...request.meta,
      leaseProvider,
      leaseBackend,
      providerCredentialFingerprint,
    },
  };
}

async function allocateWithDaemonEnv(
  req: DaemonRequest,
  daemonEnv: Record<string, string>,
): Promise<{ allocations: number; error?: AppError }> {
  const registry = new LeaseRegistry();
  let allocations = 0;
  try {
    await handleLeaseCommands({
      req,
      sessionName: req.session,
      sessionStore: makeSessionStore('agent-device-provider-credentials-'),
      leaseRegistry: registry,
      providerCredentials: readDaemonProviderCredentials(daemonEnv, '/tmp/agent device state'),
      leaseLifecycleProvider: {
        allocate: async () => {
          allocations += 1;
          return {};
        },
      },
    });
  } catch (error) {
    assert.deepEqual(registry.listActiveLeases(), []);
    return { allocations, error: error as AppError };
  }
  return { allocations };
}

test('a daemon started with only LIMRUN_API_KEY refuses a shell with instance variables before allocation', async () => {
  const outcome = await allocateWithDaemonEnv(
    providerAllocateRequest('limrun', providerCredentialFingerprint('limrun', LIMRUN_ATTACH_ENV)),
    { LIMRUN_API_KEY: 'lim-key' },
  );

  assert.equal(outcome.allocations, 0);
  assert.equal(outcome.error?.code, 'INVALID_ARGS');
  assert.equal(outcome.error?.details?.reason, 'provider-credentials-changed');
  assert.equal(outcome.error?.details?.provider, 'limrun');
  assert.match(
    String(outcome.error?.details?.hint),
    /agent-device daemon stop --state-dir '\/tmp\/agent device state'/,
  );
});

test('a Limrun lease compares only the leased platform instance variables', async () => {
  const daemonEnv = {
    ...LIMRUN_ATTACH_ENV,
    LIM_ANDROID_INSTANCE_URL: 'https://region.limrun.example/v1/android_x/api',
    LIM_ANDROID_INSTANCE_TOKEN: 'android-token',
    LIM_ANDROID_INSTANCE_ADB_URL: 'wss://region.limrun.example/v1/android_x/adb',
  };
  const shellEnv = { ...daemonEnv, LIM_ANDROID_INSTANCE_TOKEN: 'android-token-2' };
  const allocate = async (leaseBackend: 'ios-instance' | 'android-instance') =>
    await allocateWithDaemonEnv(
      providerAllocateRequest(
        'limrun',
        providerCredentialFingerprint('limrun', shellEnv, leaseBackend),
        leaseBackend,
      ),
      daemonEnv,
    );

  assert.equal((await allocate('ios-instance')).error, undefined);
  assert.equal(
    (await allocate('android-instance')).error?.details?.reason,
    'provider-credentials-changed',
  );
});

test('a daemon holding rotated BrowserStack keys refuses before allocation', async () => {
  const outcome = await allocateWithDaemonEnv(
    providerAllocateRequest(
      'browserstack',
      providerCredentialFingerprint('browserstack', {
        ...BROWSERSTACK_ENV,
        BROWSERSTACK_ACCESS_KEY: 'key-2',
      }),
    ),
    BROWSERSTACK_ENV,
  );

  assert.equal(outcome.allocations, 0);
  assert.equal(outcome.error?.details?.reason, 'provider-credentials-changed');
  assert.equal(outcome.error?.details?.provider, 'browserstack');
});

test.for([
  ['limrun', LIMRUN_ATTACH_ENV],
  ['browserstack', BROWSERSTACK_ENV],
] as const)(
  'a daemon holding the %s credentials of the shell allocates',
  async ([provider, env]) => {
    const outcome = await allocateWithDaemonEnv(
      providerAllocateRequest(provider, providerCredentialFingerprint(provider, env)),
      env,
    );

    assert.equal(outcome.error, undefined);
    assert.equal(outcome.allocations, 1);
  },
);

test('a daemon holding credentials allocates for a shell with none', async () => {
  const outcome = await allocateWithDaemonEnv(
    providerAllocateRequest('limrun', providerCredentialFingerprint('limrun', {})),
    { LIMRUN_API_KEY: 'lim-key' },
  );

  assert.equal(outcome.error, undefined);
  assert.equal(outcome.allocations, 1);
});

test('a daemon started without BrowserStack credentials refuses a shell that has them', async () => {
  const outcome = await allocateWithDaemonEnv(
    providerAllocateRequest(
      'browserstack',
      providerCredentialFingerprint('browserstack', BROWSERSTACK_ENV),
    ),
    {},
  );

  assert.equal(outcome.allocations, 0);
  assert.equal(outcome.error?.details?.reason, 'provider-credentials-changed');
  assert.match(String(outcome.error?.message), /started without the browserstack credentials/);
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
