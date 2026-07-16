import { test, expect, vi } from 'vitest';
import { makeIosSession } from '../../__tests__/test-utils/session-factories.ts';
import { makeSessionStore } from '../../__tests__/test-utils/store-factory.ts';
import { LeaseRegistry } from '../lease-registry.ts';
import {
  admitRequestLeaseForLockedScope,
  cleanupExpiredLeasedSession,
  releaseExpiredProviderLease,
  releaseSessionLease,
  resolveSessionLeaseForRequest,
} from '../lease-lifecycle.ts';
import type { DaemonRequest } from '../types.ts';

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
  sessionStore.set(
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
    req: makeRequest({ command: 'snapshot' }),
    sessionName: 'default',
    sessionStore,
    leaseRegistry,
  });

  expect(req.internal?.admittedLease?.leaseId).toBe(lease.leaseId);
  expect(req.internal?.admittedLease?.heartbeatAt).toBe(2_000);
  expect(sessionStore.get('default')?.lease?.expiresAt).toBe(302_000);
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
  sessionStore.set('default', session);
  now = 1_011;
  const teardownSession = vi.fn(async () => {});

  const cleaned = await cleanupExpiredLeasedSession({
    sessionName: 'default',
    sessionStore,
    leaseRegistry,
    teardownSession,
  });

  expect(cleaned).toBe(true);
  expect(teardownSession).toHaveBeenCalledWith(session, 'default');
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
      leaseBackend: lease.backend,
      leaseProvider: lease.leaseProvider,
      deviceKey: lease.deviceKey,
      clientId: lease.clientId,
    },
  });

  const provider = await releaseSessionLease({
    session,
    leaseRegistry,
    leaseLifecycleProvider: {
      release: async (lease) => ({ provider: lease.leaseProvider }),
    },
  });

  expect(leaseRegistry.listActiveLeases()).toHaveLength(0);
  expect(provider).toEqual({ provider: 'proxy' });
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
