import { bindTestCommandHost } from '@agent-device/test-kit';
import { test, expect, vi } from 'vitest';
import { emitDiagnostic } from '@agent-device/host-kit/diagnostics';
import { makeIosSession } from '../../__tests__/support/session-factories.ts';
import { makeSessionStore } from '../../__tests__/support/store-factory.ts';
import { LeaseRegistry } from '../../resources/lease-registry.ts';
import {
  admitRequestLeaseForLockedScope,
  cleanupExpiredLeasedSession,
  releaseExpiredProviderLease,
  releaseSessionLease,
  resolveSessionLeaseForRequest,
} from '../lease-lifecycle.ts';
import type { DaemonRequest } from '../../core/daemon-request.ts';

bindTestCommandHost();

vi.mock('@agent-device/host-kit/diagnostics', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent-device/host-kit/diagnostics')>();
  return { ...actual, emitDiagnostic: vi.fn() };
});

test('admitRequestLeaseForLockedScope heartbeats and stores admitted lease on the request', () => {
  let now = 1_000;
  const sessionStore = makeSessionStore('agent-device-lease-lifecycle-');
  const leaseRegistry = new LeaseRegistry({ now: () => now });
  const lease = leaseRegistry.allocateLease({
    tenantId: 'tenant-a',
    runId: 'run-1',
    leaseProvider: 'proxy',
    deviceKey: 'ios:SIM-001',
    clientId: 'client-a',
  });
  sessionStore.publish(
    'default',
    makeIosSession('default', {
      lease: {
        leaseId: lease.leaseId,
        tenantId: lease.tenantId,
        runId: lease.runId,
        leaseBackend: lease.backend,
        leaseProvider: lease.leaseProvider,
        deviceKey: lease.deviceKey,
        clientId: lease.clientId,
        expiresAt: lease.expiresAt,
      },
    }),
  );
  now = 2_000;

  const req = admitRequestLeaseForLockedScope({
    env: process.env,
    req: makeRequest({ command: 'snapshot' }),
    sessionName: 'default',
    sessionStore,
    leaseRegistry,
  });

  expect(req.internal?.admittedLease?.leaseId).toBe(lease.leaseId);
  expect(req.internal?.admittedLease?.heartbeatAt).toBe(2_000);
  // Renewal is for the window the lease carries — the registry default here, since this client
  // named none — not the proxy-specific default admission used to name on every request (#2946).
  expect(sessionStore.get('default')?.lease?.expiresAt).toBe(62_000);
});

// A client that let admission check its lease (`lease-admission`) reallocates and resends only on
// this refusal, so it has to say that nothing ran.
test('admitRequestLeaseForLockedScope refuses an unknown or expired lease before dispatch', () => {
  let now = 1_000;
  const leaseRegistry = new LeaseRegistry({ now: () => now, defaultLeaseTtlMs: 10_000 });
  const expired = leaseRegistry.allocateLease({ tenantId: 'tenant-a', runId: 'run-1' });
  now += 20_000;

  for (const leaseId of ['0'.repeat(32), expired.leaseId]) {
    expect(() =>
      admitRequestLeaseForLockedScope({
        env: process.env,
        req: makeRequest({
          command: 'press',
          positionals: ['100', '200'],
          meta: { tenantId: 'tenant-a', runId: 'run-1', leaseId },
        }),
        sessionName: 'default',
        sessionStore: makeSessionStore('agent-device-lease-lifecycle-'),
        leaseRegistry,
      }),
    ).toThrow(
      expect.objectContaining({
        code: 'UNAUTHORIZED',
        details: expect.objectContaining({ reason: 'LEASE_NOT_FOUND', dispatched: 'no' }),
      }),
    );
  }
});

test('cleanupExpiredLeasedSession consumes expired lease and deletes the session after teardown', async () => {
  let now = 1_000;
  const sessionStore = makeSessionStore('agent-device-lease-lifecycle-');
  const leaseRegistry = new LeaseRegistry({
    defaultLeaseTtlMs: 10,
    minLeaseTtlMs: 1,
    now: () => now,
  });
  const lease = leaseRegistry.allocateLease({ tenantId: 'tenant-a', runId: 'run-1' });
  const session = makeIosSession('default', {
    lease: {
      leaseId: lease.leaseId,
      tenantId: lease.tenantId,
      runId: lease.runId,
      leaseBackend: lease.backend,
      expiresAt: lease.expiresAt,
    },
  });
  sessionStore.publish('default', session);
  now = 1_011;
  const teardownSession = vi.fn(async () => {});

  const cleaned = await cleanupExpiredLeasedSession({
    req: makeRequest({ command: 'snapshot' }),
    env: process.env,
    sessionName: 'default',
    sessionStore,
    leaseRegistry,
    teardownSession,
    whileSessionIdle: async (_ref, end) => await end(),
  });

  expect(cleaned).toBe(true);
  expect(teardownSession).toHaveBeenCalledWith(
    expect.objectContaining({ address: 'default', session }),
  );
  expect(sessionStore.get('default')).toBeUndefined();
  expect(leaseRegistry.listActiveLeases()).toHaveLength(0);
});

function sessionWithExpiredLease() {
  let now = 1_000;
  const sessionStore = makeSessionStore('agent-device-lease-lifecycle-');
  const leaseRegistry = new LeaseRegistry({
    defaultLeaseTtlMs: 10,
    minLeaseTtlMs: 1,
    now: () => now,
  });
  const lease = leaseRegistry.allocateLease({ tenantId: 'tenant-a', runId: 'run-1' });
  const session = makeIosSession('default', {
    lease: { leaseId: lease.leaseId, tenantId: lease.tenantId, runId: lease.runId },
  });
  sessionStore.publish('default', session);
  now = 1_011;
  const teardownSession = vi.fn(async () => {});
  const cleanup = (
    request: Partial<DaemonRequest> & Pick<DaemonRequest, 'command'>,
    spell: (leaseId: string) => string = (leaseId) => leaseId,
  ) =>
    cleanupExpiredLeasedSession({
      req: makeRequest({
        meta: { tenantId: 'tenant-a', runId: 'run-1', leaseId: spell(lease.leaseId) },
        ...request,
      }),
      env: process.env,
      sessionName: 'default',
      sessionStore,
      leaseRegistry,
      teardownSession,
      whileSessionIdle: async (_ref, end) => await end(),
    });
  return { sessionStore, session, teardownSession, cleanup };
}

// The refusal says `dispatched: no`, so a request that would do device work under the expired lease
// must not tear its session down (recording, claim, runner) before the client reallocates; the
// expiry sweep does that.
test.each<
  [string, Partial<DaemonRequest> & Pick<DaemonRequest, 'command'>, (leaseId: string) => string]
>([
  ['press', { command: 'press' }, (id) => id],
  // The registry reads lease ids without case or surrounding space.
  ['a press spelling the id differently', { command: 'press' }, (id) => ` ${id.toUpperCase()} `],
  ['an app-only close', { command: 'close', internal: { closeAppOnly: true } }, (id) => id],
])(
  'cleanupExpiredLeasedSession refuses %s naming the expired lease before any teardown',
  async (_name, request, spell) => {
    const { sessionStore, session, teardownSession, cleanup } = sessionWithExpiredLease();

    await expect(cleanup(request, spell)).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
      details: { reason: 'LEASE_NOT_FOUND', dispatched: 'no' },
    });
    expect(teardownSession).not.toHaveBeenCalled();
    expect(sessionStore.get('default')).toBe(session);
  },
);

test.each(['close', 'lease_release', 'lease_heartbeat'])(
  'cleanupExpiredLeasedSession tears down for %s naming the expired lease',
  async (command) => {
    const { sessionStore, teardownSession, cleanup } = sessionWithExpiredLease();

    await expect(cleanup({ command })).resolves.toBe(true);
    expect(teardownSession).toHaveBeenCalledOnce();
    expect(sessionStore.get('default')).toBeUndefined();
  },
);

test('releaseSessionLease releases with the stored session owner scope', async () => {
  const leaseRegistry = new LeaseRegistry();
  const lease = leaseRegistry.allocateLease({
    tenantId: 'tenant-a',
    runId: 'run-1',
    leaseBackend: 'ios-instance',
    leaseProvider: 'proxy',
    deviceKey: 'ios:SIM-001',
    clientId: 'client-a',
  });
  const session = makeIosSession('default', {
    lease: {
      leaseId: lease.leaseId,
      tenantId: lease.tenantId,
      runId: lease.runId,
      leaseBackend: lease.backend,
      leaseProvider: lease.leaseProvider,
      deviceKey: lease.deviceKey,
      clientId: lease.clientId,
    },
  });

  const released = await releaseSessionLease({
    session,
    leaseRegistry,
    leaseLifecycleProvider: {
      release: async (lease) => ({ provider: lease.leaseProvider }),
    },
  });

  expect(leaseRegistry.listActiveLeases()).toHaveLength(0);
  expect(released).toEqual({ endedLeaseId: lease.leaseId, providerData: { provider: 'proxy' } });
});

test('releaseSessionLease leaves a retainOnClose lease and its provider device alone', async () => {
  const leaseRegistry = new LeaseRegistry();
  const lease = leaseRegistry.allocateLease({
    tenantId: 'tenant-a',
    runId: 'run-1',
    clientId: 'client-a',
    retainOnClose: true,
  });
  const session = makeIosSession('default', {
    lease: {
      leaseId: lease.leaseId,
      tenantId: lease.tenantId,
      runId: lease.runId,
      leaseBackend: lease.backend,
      clientId: lease.clientId,
    },
  });
  const release = vi.fn(async () => ({ released: true }));

  const retained = await releaseSessionLease({
    session,
    leaseRegistry,
    leaseLifecycleProvider: { release },
  });

  expect(retained).toEqual({});
  expect(release).not.toHaveBeenCalled();
  expect(leaseRegistry.listActiveLeases()).toHaveLength(1);
  expect(vi.mocked(emitDiagnostic)).toHaveBeenCalledWith({
    level: 'info',
    phase: 'session_lease_released',
    data: { session: 'default', leaseId: lease.leaseId, released: false, retained: true },
  });
});

test('releaseSessionLease ends no lease for a session that holds none', async () => {
  const release = vi.fn(async () => ({ released: true }));

  const outcome = await releaseSessionLease({
    session: makeIosSession('default'),
    leaseRegistry: new LeaseRegistry(),
    leaseLifecycleProvider: { release },
  });

  expect(outcome).toEqual({});
  expect(release).not.toHaveBeenCalled();
});

test('releaseSessionLease retains provider session ownership for artifact lookup', async () => {
  const leaseRegistry = new LeaseRegistry();
  const lease = leaseRegistry.allocateLease({
    tenantId: 'tenant-a',
    runId: 'run-1',
    leaseBackend: 'android-instance',
    leaseProvider: 'browserstack',
  });
  const session = makeIosSession('default', {
    lease: {
      leaseId: lease.leaseId,
      tenantId: lease.tenantId,
      runId: lease.runId,
      leaseBackend: lease.backend,
      leaseProvider: lease.leaseProvider,
    },
  });

  await releaseSessionLease({
    session,
    leaseRegistry,
    leaseLifecycleProvider: {
      release: async () => ({ providerSessionId: 'bs-session-1' }),
    },
  });

  expect(
    leaseRegistry.resolveProviderSession({
      provider: 'browserstack',
      providerSessionId: 'bs-session-1',
      tenantId: 'tenant-a',
    }),
  ).toMatchObject({ leaseId: lease.leaseId, tenantId: 'tenant-a' });
});

test('releaseExpiredProviderLease releases a provider-owned lease without a session', async () => {
  const lease = new LeaseRegistry().allocateLease({
    tenantId: 'tenant-a',
    runId: 'run-1',
    leaseProvider: 'limrun',
  });
  const recover = vi.fn(async () => undefined);

  await releaseExpiredProviderLease(recover, lease);

  expect(recover).toHaveBeenCalledWith(lease);
});

test('releaseSessionLease keeps the local lease when the provider release fails', async () => {
  const leaseRegistry = new LeaseRegistry();
  const lease = leaseRegistry.allocateLease({
    tenantId: 'tenant-a',
    runId: 'run-1',
    leaseBackend: 'ios-instance',
    leaseProvider: 'proxy',
    deviceKey: 'ios:SIM-001',
    clientId: 'client-a',
  });
  const session = makeIosSession('default', {
    lease: {
      leaseId: lease.leaseId,
      tenantId: lease.tenantId,
      runId: lease.runId,
      leaseBackend: lease.backend,
      leaseProvider: lease.leaseProvider,
      deviceKey: lease.deviceKey,
      clientId: lease.clientId,
    },
  });

  await expect(
    releaseSessionLease({
      session,
      leaseRegistry,
      leaseLifecycleProvider: {
        release: async () => {
          throw new Error('provider unavailable');
        },
      },
    }),
  ).rejects.toThrow('provider unavailable');

  expect(leaseRegistry.listActiveLeases()).toEqual([lease]);
});

test('resolveSessionLeaseForRequest prefers admitted lease and falls back to existing lease', () => {
  const leaseRegistry = new LeaseRegistry();
  const lease = leaseRegistry.allocateLease({
    tenantId: 'tenant-a',
    runId: 'run-1',
    leaseBackend: 'ios-instance',
    leaseProvider: 'proxy',
    deviceKey: 'ios:SIM-001',
    clientId: 'client-a',
  });
  const req = makeRequest({
    meta: {
      tenantId: 'tenant-a',
      runId: 'run-1',
      leaseId: lease.leaseId,
      leaseBackend: lease.backend,
      leaseProvider: 'proxy',
      deviceKey: 'ios:SIM-001',
      clientId: 'client-a',
    },
    internal: { admittedLease: lease },
  });

  const resolved = resolveSessionLeaseForRequest({
    req,
    existingLease: {
      leaseId: 'older',
      tenantId: 'tenant-a',
      runId: 'run-1',
    },
  });

  expect(resolved?.leaseId).toBe(lease.leaseId);
  expect(resolved?.expiresAt).toBe(lease.expiresAt);
});

function makeRequest(overrides: Partial<DaemonRequest> = {}): DaemonRequest {
  return {
    token: 'token',
    session: 'default',
    command: 'snapshot',
    positionals: [],
    flags: {},
    ...overrides,
  };
}
