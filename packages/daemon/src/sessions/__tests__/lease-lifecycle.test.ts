import fs from 'node:fs';
import { test, expect, vi } from 'vitest';
import { emitDiagnostic } from '@agent-device/host-kit/diagnostics';
import { makeIosSession } from '../../__tests__/support/session-factories.ts';
import { makeSessionStore } from '../../__tests__/support/store-factory.ts';
import {
  isolatedDeviceClaimStores,
  retainOrphanedDeviceClaims,
} from '../../__tests__/support/device-claim-store.ts';
import { acquireDeviceClaim } from '../../resources/device/device-claims.ts';
import { resolveDeviceClaimPath } from '../../resources/device/device-claim-paths.ts';
import { existingSessionExecutionLockKeys } from '../../server/request-binding.ts';
import { withRequestExecutionLockKeys } from '../../server/request-execution-locks.ts';
import { LeaseRegistry } from '../../resources/lease-registry.ts';
import type { SessionStore } from '../../core/session-store.ts';
import {
  admitRequestLeaseForLockedScope,
  cleanupExpiredLeasedSession,
  endLeaseSessions,
  releaseExpiredProviderLease,
  releaseSessionLease,
  resolveSessionLeaseForRequest,
} from '../lease-lifecycle.ts';
import type { DaemonRequest } from '../../core/daemon-request.ts';

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
    sessionName: 'default',
    sessionStore,
    leaseRegistry,
    teardownSession,
  });

  expect(cleaned).toBe(true);
  expect(teardownSession).toHaveBeenCalledWith(
    expect.objectContaining({ address: 'default', session }),
  );
  expect(sessionStore.get('default')).toBeUndefined();
  expect(leaseRegistry.listActiveLeases()).toHaveLength(0);
});

const claimStores = isolatedDeviceClaimStores('agent-device-lease-end-claims-');

async function publishLeasedSession(
  sessionStore: SessionStore,
  name: string,
  leaseId: string,
): Promise<string> {
  const { stateDir } = claimStores();
  const session = makeIosSession(name, {
    lease: { leaseId, tenantId: 'tenant-a', runId: 'run-1' },
  });
  const acquired = await acquireDeviceClaim({
    device: session.device,
    session: name,
    workspace: stateDir,
    stateDir,
    reconcileOrphanedDeviceClaim: retainOrphanedDeviceClaims,
  });
  if (acquired.status !== 'acquired') throw new Error('expected an acquired claim');
  sessionStore.publish(name, { ...session, deviceClaim: acquired.ownership });
  return resolveDeviceClaimPath(acquired.ownership.deviceKey);
}

test('endLeaseSessions ends the session opened under the lease and clears its device claim', async () => {
  const sessionStore = makeSessionStore('agent-device-lease-end-');
  const claimPath = await publishLeasedSession(sessionStore, 'leased', 'lease-1');
  sessionStore.publish(
    'other',
    makeIosSession('other', {
      lease: { leaseId: 'lease-2', tenantId: 'tenant-b', runId: 'run-2' },
    }),
  );
  expect(fs.existsSync(claimPath)).toBe(true);
  const teardownSession = vi.fn(async () => {});

  await endLeaseSessions({
    leaseId: 'lease-1',
    reason: 'LEASE_RELEASED',
    sessionStore,
    withSessionLocks: async (_ref, task) => await task(),
    teardownSession,
  });

  expect(teardownSession).toHaveBeenCalledTimes(1);
  expect(teardownSession).toHaveBeenCalledWith(expect.objectContaining({ address: 'leased' }));
  expect(sessionStore.get('leased')).toBeUndefined();
  expect(fs.existsSync(claimPath)).toBe(false);
  expect(sessionStore.get('other')).toBeDefined();
});

test('endLeaseSessions clears the claim of a session whose device no longer answers', async () => {
  const sessionStore = makeSessionStore('agent-device-lease-end-unreachable-');
  const claimPath = await publishLeasedSession(sessionStore, 'leased', 'lease-1');

  await endLeaseSessions({
    leaseId: 'lease-1',
    reason: 'LEASE_EXPIRED',
    sessionStore,
    withSessionLocks: async (_ref, task) => await task(),
    teardownSession: async () => {
      throw new Error('device unreachable');
    },
  });

  expect(sessionStore.get('leased')).toBeUndefined();
  expect(fs.existsSync(claimPath)).toBe(false);
});

test('endLeaseSessions waits for the command still running on the session', async () => {
  const sessionStore = makeSessionStore('agent-device-lease-end-locked-');
  await publishLeasedSession(sessionStore, 'leased', 'lease-1');
  const executionLocks = new Map<string, Promise<unknown>>();
  let finishCommand!: () => void;
  const commandRunning = new Promise<void>((resolve) => {
    finishCommand = resolve;
  });
  const command = withRequestExecutionLockKeys(
    executionLocks,
    existingSessionExecutionLockKeys('leased', sessionStore.get('leased')!.device.id),
    async () => await commandRunning,
  );
  const teardownSession = vi.fn(async () => {});

  const ending = endLeaseSessions({
    leaseId: 'lease-1',
    reason: 'LEASE_RELEASED',
    sessionStore,
    withSessionLocks: async (ref, task) =>
      await withRequestExecutionLockKeys(
        executionLocks,
        existingSessionExecutionLockKeys(ref.address, ref.session.device.id),
        task,
      ),
    teardownSession,
  });
  await new Promise((resolve) => setImmediate(resolve));
  expect(teardownSession).not.toHaveBeenCalled();
  expect(sessionStore.get('leased')).toBeDefined();

  finishCommand();
  await command;
  await ending;
  expect(teardownSession).toHaveBeenCalledTimes(1);
  expect(sessionStore.get('leased')).toBeUndefined();
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

  const provider = await releaseSessionLease({
    session,
    leaseRegistry,
    leaseLifecycleProvider: { release },
  });

  expect(provider).toBeUndefined();
  expect(release).not.toHaveBeenCalled();
  expect(leaseRegistry.listActiveLeases()).toHaveLength(1);
  expect(vi.mocked(emitDiagnostic)).toHaveBeenCalledWith({
    level: 'info',
    phase: 'session_lease_released',
    data: { session: 'default', leaseId: lease.leaseId, released: false, retained: true },
  });
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
