import { expect, test, vi } from 'vitest';
import {
  daemonPlatformServicesFixture,
  daemonClaimRecoveryGatewayFixture,
} from '../../__tests__/support/platform-services-fixture.ts';
import { makeSession } from '../../__tests__/support/session-factories.ts';
import fs from 'node:fs';
import {
  LINUX_DEVICE,
  createTestHostEnvironment,
  bindTestCommandHost,
  deviceClaimFilePath,
} from '@agent-device/test-kit';
import { acquireDeviceClaim } from '@agent-device/daemon-contracts/device-claims';
import {
  isolatedDeviceClaimStores,
  retainOrphanedDeviceClaims,
} from '../../__tests__/support/device-claim-store.ts';
import { makeSessionStore } from '../../__tests__/support/store-factory.ts';
import { LeaseRegistry } from '../../resources/lease-registry.ts';
import { createRequestExecutionScope } from '../request-execution-scope.ts';
import type { DaemonRequest } from '../../core/daemon-request.ts';
import {
  platformRequestScopeFixture,
  unavailableDeviceRuntimeGateway,
} from '../../__tests__/support/unavailable-device-runtime-gateway.ts';

bindTestCommandHost();

const claimStores = isolatedDeviceClaimStores('agent-device-request-scope-claims-');

function makeRequest(overrides: Partial<DaemonRequest>): DaemonRequest {
  return {
    token: 't',
    session: 'default',
    command: 'snapshot',
    positionals: [],
    flags: {},
    ...overrides,
  };
}

test('expired leases remove owned sessions before the next command and free capacity', async () => {
  let now = 1_000;
  const sessionStore = makeSessionStore('agent-device-request-scope-');
  const leaseRegistry = new LeaseRegistry({
    maxActiveSimulatorLeases: 1,
    defaultLeaseTtlMs: 10,
    minLeaseTtlMs: 1,
    now: () => now,
  });
  const lease = leaseRegistry.allocateLease({ tenantId: 'tenant-a', runId: 'run-1' });
  sessionStore.publish(
    'default',
    makeSession('default', {
      device: LINUX_DEVICE,
      lease: {
        leaseId: lease.leaseId,
        tenantId: lease.tenantId,
        runId: lease.runId,
        leaseBackend: lease.backend,
        leaseProvider: 'proxy',
        deviceKey: 'ios:SIM-001',
        expiresAt: lease.expiresAt,
      },
    }),
  );
  now = 1_011;

  const scope = await createRequestExecutionScope({
    host: createTestHostEnvironment(),
    platformServices: daemonPlatformServicesFixture(),
    claimRecoveryGateway: daemonClaimRecoveryGatewayFixture(),
    trackClaimRecoveryDisposal: () => {},
    deviceRuntimeGateway: unavailableDeviceRuntimeGateway,
    platformRequestScope: platformRequestScopeFixture(),
    req: makeRequest({ command: 'snapshot' }),
    sessionStore,
    leaseRegistry,
  });
  await scope.runLocked(async () => 'ran');

  expect(sessionStore.get('default')).toBeUndefined();
  const nextLease = leaseRegistry.allocateLease({ tenantId: 'tenant-b', runId: 'run-2' });
  expect(nextLease.tenantId).toBe('tenant-b');
});

test.each(['rebuild', 'retire'] as const)(
  'scoped lease expiry preserves a public-name session and a %s during held teardown',
  async (change) => {
    let now = 1_000;
    const store = makeSessionStore('request-scope-lease-lifetime-');
    const leases = new LeaseRegistry({ defaultLeaseTtlMs: 10, minLeaseTtlMs: 1, now: () => now });
    const lease = leases.allocateLease({ tenantId: 'tenant-a', runId: 'run-1' });
    const address = 'cwd:ownership:default';
    const original = store.publish(
      address,
      makeSession('default', {
        device: LINUX_DEVICE,
        sessionScope: { kind: 'cwd', id: 'ownership' },
        lease: {
          leaseId: lease.leaseId,
          tenantId: lease.tenantId,
          runId: lease.runId,
          leaseBackend: lease.backend,
        },
      }),
    );
    const decoy = store.publish(
      'default',
      makeSession('default', {
        device: { ...LINUX_DEVICE, id: 'public-name-decoy' },
        appName: 'decoy',
      }),
    );
    let enter!: () => void;
    let resume!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const release = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const stopSnapshotHelper = vi.fn(async () => {
      enter();
      await release;
    });
    now = 1_011;
    const scope = await createRequestExecutionScope({
      host: createTestHostEnvironment(),
      platformServices: daemonPlatformServicesFixture(),
      claimRecoveryGateway: daemonClaimRecoveryGatewayFixture(),
      trackClaimRecoveryDisposal: () => {},
      deviceRuntimeGateway: unavailableDeviceRuntimeGateway,
      platformRequestScope: platformRequestScopeFixture(),
      req: makeRequest({ session: address, flags: { session: address } }),
      sessionStore: store,
      leaseRegistry: leases,
      platformResourceCleanup: {
        stopSnapshotHelper,
        closeManagedBrowser: async () => {},
        cleanupSessionlessExecutionHost: async () => {},
        retainExecutionHostAfterClose: () => false,
      },
    });
    expect(scope.sessionName).toBe(address);
    const running = scope.runLocked(async () => 'ran');
    await entered;
    let successor: ReturnType<typeof store.publish> | undefined;
    if (change === 'retire') {
      store.retire(original);
      successor = store.publish(
        address,
        makeSession('default', {
          device: { ...LINUX_DEVICE, id: 'successor' },
          appName: 'successor',
        }),
      );
    } else store.update(original, { appName: 'latest' });
    resume();
    await expect(running).resolves.toBe('ran');
    expect(stopSnapshotHelper).toHaveBeenCalledExactlyOnceWith(original.session.device);
    expect(store.requireCurrent(decoy)).toBe(decoy.session);
    if (successor) expect(store.requireCurrent(successor)).toBe(successor.session);
    else expect(store.lookup(address)).toBeUndefined();
  },
);

test.each(['expired', 'released'] as const)(
  'a close naming its session lease that is %s tears down the session and claim and rents nothing',
  async (fate) => {
    let now = 1_000;
    const sessionStore = makeSessionStore('agent-device-request-scope-');
    const leaseRegistry = new LeaseRegistry({
      defaultLeaseTtlMs: 10,
      minLeaseTtlMs: 1,
      now: () => now,
    });
    const owner = { tenantId: 'tenant-a', runId: 'run-1' };
    const lease = leaseRegistry.allocateLease(owner);
    const meta = { ...owner, leaseId: lease.leaseId, sessionIsolation: 'tenant' as const };
    const session = makeSession('tenant-a:default', {
      device: LINUX_DEVICE,
      lease: { ...owner, leaseId: lease.leaseId, leaseBackend: lease.backend },
    });
    const { stateDir } = claimStores();
    const claim = await acquireDeviceClaim({
      env: process.env,
      device: session.device,
      session: session.name,
      workspace: stateDir,
      stateDir,
      reconcileOrphanedDeviceClaim: retainOrphanedDeviceClaims,
    });
    if (claim.status !== 'acquired') throw new Error('expected an acquired claim');
    sessionStore.publish(session.name, { ...session, deviceClaim: claim.ownership });
    const claimFile = deviceClaimFilePath(claim.ownership.deviceKey);
    expect(fs.existsSync(claimFile)).toBe(true);
    if (fate === 'expired') now = 1_011;
    else leaseRegistry.releaseLease({ ...owner, leaseId: lease.leaseId });
    const task = vi.fn(async () => 'ran');

    const scope = await createRequestExecutionScope({
      host: createTestHostEnvironment(),
      platformServices: daemonPlatformServicesFixture(),
      claimRecoveryGateway: daemonClaimRecoveryGatewayFixture(),
      trackClaimRecoveryDisposal: () => {},
      deviceRuntimeGateway: unavailableDeviceRuntimeGateway,
      platformRequestScope: platformRequestScopeFixture(),
      req: makeRequest({ command: 'close', session: session.name, meta }),
      sessionStore,
      leaseRegistry,
      platformResourceCleanup: {
        stopSnapshotHelper: async () => {},
        closeManagedBrowser: async () => {},
        cleanupSessionlessExecutionHost: async () => {},
        retainExecutionHostAfterClose: () => false,
      },
    });
    const refusal = await scope.runLocked(task).catch((error: unknown) => error);

    expect(sessionStore.get(session.name)).toBeUndefined();
    expect(fs.existsSync(claimFile)).toBe(false);
    expect(leaseRegistry.listActiveLeases()).toEqual([]);
    expect(task).not.toHaveBeenCalled();
    // The lease is still refused, without claiming that nothing ran.
    expect(refusal).toMatchObject({ details: { reason: 'LEASE_NOT_FOUND' } });
    expect(refusal).not.toHaveProperty('details.dispatched');
  },
);
