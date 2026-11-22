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
  resolveLockedRequestSessionRef,
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
        backend: lease.backend,
        leaseProvider: lease.leaseProvider,
        deviceKey: lease.deviceKey,
        clientId: lease.clientId,
      },
    }),
  );
  now = 2_000;

  const req = admitRequestLeaseForLockedScope({
    env: process.env,
    req: makeRequest({ command: 'snapshot', meta: { leaseId: lease.leaseId } }),
    sessionName: 'default',
    sessionStore,
    leaseRegistry,
  });

  expect(req.internal?.admittedLease?.leaseId).toBe(lease.leaseId);
  expect(req.internal?.admittedLease?.heartbeatAt).toBe(2_000);
  // Renewal is for the window the lease carries — the registry default here, since this client
  // named none — not the proxy-specific default admission used to name on every request (#2946).
  expect(leaseRegistry.listActiveLeases()[0]?.expiresAt).toBe(62_000);
});

test('admitRequestLeaseForLockedScope renews no session for a command that ignores the session lease', () => {
  const sessionStore = makeSessionStore('agent-device-lease-lifecycle-');
  const leaseRegistry = new LeaseRegistry();
  const own = leaseRegistry.allocateLease({ tenantId: 'tenant-a', runId: 'run-b' });
  const sessionLease = {
    leaseId: 'a'.repeat(32),
    tenantId: 'tenant-a',
    runId: 'run-a',
    leaseBackend: 'macos-app',
  } as const;
  sessionStore.publish('default', makeIosSession('default', { lease: sessionLease }));

  const req = admitRequestLeaseForLockedScope({
    env: process.env,
    req: makeRequest({
      command: 'devices',
      meta: { leaseId: own.leaseId, tenantId: 'tenant-a', runId: 'run-b' },
    }),
    sessionName: 'default',
    sessionStore,
    leaseRegistry,
  });

  // The addressed app lease still makes `devices` need a lease; it is admitted under its own.
  expect(req.internal?.admittedLease?.leaseId).toBe(own.leaseId);
  expect(sessionStore.get('default')?.lease).toEqual(sessionLease);
});

test('resolveLockedRequestSessionRef ends nothing when the successor lease expires while it waits for the device lock', async () => {
  let now = 1_000;
  const sessionStore = makeSessionStore('agent-device-lease-lifecycle-');
  const leaseRegistry = new LeaseRegistry({ minLeaseTtlMs: 1, now: () => now });
  const expired = leaseRegistry.allocateLease({ tenantId: 'tenant-a', runId: 'run-a', ttlMs: 10 });
  const successor = leaseRegistry.allocateLease({
    tenantId: 'tenant-a',
    runId: 'run-b',
    ttlMs: 50,
  });
  const ref = sessionStore.publish(
    'default',
    makeIosSession('default', {
      lease: { leaseId: expired.leaseId, tenantId: expired.tenantId, runId: expired.runId },
    }),
  );
  now = 1_020;
  const teardownSession = vi.fn(async () => {});

  await expect(
    resolveLockedRequestSessionRef({
      env: process.env,
      req: makeRequest({ command: 'open', meta: { leaseId: successor.leaseId } }),
      sessionName: 'default',
      sessionStore,
      leaseRegistry,
      teardown: 'inline',
      holdDeviceLock: async () => {
        now = 1_060;
      },
      teardownSession,
      admission: {},
    }),
  ).rejects.toMatchObject({ details: { reason: 'LEASE_SESSION_MISMATCH' } });

  expect(teardownSession).not.toHaveBeenCalled();
  expect(sessionStore.lookup('default')?.lifetime).toBe(ref.lifetime);
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
      backend: lease.backend,
    },
  });
  sessionStore.publish('default', session);
  now = 1_011;
  const teardownSession = vi.fn(async () => {});

  const cleaned = await cleanupExpiredLeasedSession({
    env: process.env,
    ref: sessionStore.lookup('default'),
    sessionStore,
    leaseRegistry,
    teardownSession,
    teardown: 'inline',
  });

  expect(cleaned).toBe(true);
  expect(teardownSession).toHaveBeenCalledWith(
    expect.objectContaining({ address: 'default', session }),
  );
  expect(sessionStore.get('default')).toBeUndefined();
  expect(leaseRegistry.listActiveLeases()).toHaveLength(0);
});

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
      backend: lease.backend,
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
      backend: lease.backend,
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
      backend: lease.backend,
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
      backend: lease.backend,
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
