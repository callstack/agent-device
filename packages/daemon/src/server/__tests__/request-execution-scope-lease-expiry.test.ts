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
import {
  createLeaseSessionEnd,
  createRequestExecutionScope,
  getLeaseRegistryExecutionLocks,
} from '../request-execution-scope.ts';
import { existingSessionExecutionLockKeys } from '../request-binding.ts';
import { withRequestExecutionLockKeys } from '../request-execution-locks.ts';
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

/** A tenant session that holds a lease and a device claim, with the lease then expired or released. */
async function sessionWhoseLeaseEnded(fate: 'expired' | 'released') {
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

  const leaseEnd = createLeaseSessionEnd({
    env: process.env,
    sessionStore,
    executionLocks: getLeaseRegistryExecutionLocks(leaseRegistry),
    teardownSession: async () => {},
    cleanupSessionlessExecutionHost: async () => {},
  });
  const scopeFor = async (command: string, requestMeta: DaemonRequest['meta'] = meta) =>
    await createRequestExecutionScope({
      host: createTestHostEnvironment(),
      platformServices: daemonPlatformServicesFixture(),
      claimRecoveryGateway: daemonClaimRecoveryGatewayFixture(),
      trackClaimRecoveryDisposal: () => {},
      deviceRuntimeGateway: unavailableDeviceRuntimeGateway,
      platformRequestScope: platformRequestScopeFixture(),
      req: makeRequest({ command, session: session.name, meta: requestMeta }),
      sessionStore,
      leaseRegistry,
      endSessionsForLease: async (leaseId) => await leaseEnd.end(leaseId, 'LEASE_RELEASED'),
      platformResourceCleanup: {
        stopSnapshotHelper: async () => {},
        closeManagedBrowser: async () => {},
        cleanupSessionlessExecutionHost: async () => {},
        retainExecutionHostAfterClose: () => false,
      },
    });
  const run = async (command: string, task: () => Promise<unknown>) =>
    await (await scopeFor(command)).runLocked(task);
  /** Another request that holds the session until `finish`. */
  const holdSession = () => {
    let finish!: () => void;
    const running = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const held = withRequestExecutionLockKeys(
      getLeaseRegistryExecutionLocks(leaseRegistry),
      existingSessionExecutionLockKeys(session.name, session.device.id),
      async () => await running,
    );
    return async () => {
      finish();
      await held;
    };
  };
  const expectSessionEnded = () => {
    expect(sessionStore.get(session.name)).toBeUndefined();
    expect(fs.existsSync(claimFile)).toBe(false);
  };
  return { sessionStore, leaseRegistry, session, scopeFor, run, holdSession, expectSessionEnded };
}

test.each(['expired', 'released'] as const)(
  'a close naming its session lease that is %s tears down the session and claim and rents nothing',
  async (fate) => {
    const { leaseRegistry, run, expectSessionEnded } = await sessionWhoseLeaseEnded(fate);
    const task = vi.fn(async () => 'ran');

    const refusal = await run('close', task).catch((error: unknown) => error);

    expectSessionEnded();
    expect(leaseRegistry.listActiveLeases()).toEqual([]);
    expect(task).not.toHaveBeenCalled();
    // The lease is still refused, without claiming that nothing ran.
    expect(refusal).toMatchObject({ details: { reason: 'LEASE_NOT_FOUND' } });
    expect(refusal).not.toHaveProperty('details.dispatched');
  },
);

test.each(['lease_release', 'lease_heartbeat'])(
  '%s for a released lease ends the session still holding it',
  async (command) => {
    const { run, expectSessionEnded } = await sessionWhoseLeaseEnded('released');

    await run(command, async () => 'ran');

    await vi.waitFor(expectSessionEnded);
  },
);

// `runAdmitted` takes no lock, as for a close whose lock plan missed the session's keys.
test('a close that finds its session busy ends it once that request finishes', async () => {
  const { sessionStore, session, scopeFor, holdSession, expectSessionEnded } =
    await sessionWhoseLeaseEnded('released');
  const release = holdSession();

  const refusal = await (
    await scopeFor('close')
  )
    .runAdmitted(async () => 'ran')
    .catch((error: unknown) => error);

  expect(refusal).toMatchObject({ details: { reason: 'LEASE_NOT_FOUND' } });
  // The teardown is queued, so the refusal cannot claim that nothing runs.
  expect(refusal).not.toHaveProperty('details.dispatched');
  expect(sessionStore.get(session.name)).toBeDefined();
  await release();
  await vi.waitFor(expectSessionEnded);
});

// A lease end started under the close's own session lock would hold that lock until it got the rest.
test('a close holding only its session lock finishes while another request holds the device', async () => {
  const { leaseRegistry, session, scopeFor, expectSessionEnded } =
    await sessionWhoseLeaseEnded('released');
  const executionLocks = getLeaseRegistryExecutionLocks(leaseRegistry);
  let finish!: () => void;
  const running = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const device = withRequestExecutionLockKeys(
    executionLocks,
    [`device:${session.device.id}`],
    async () => await running,
  );
  const scope = await scopeFor('close');

  const refusal = await withRequestExecutionLockKeys(
    executionLocks,
    [`session:${session.name}`],
    async () => await scope.runAdmitted(async () => 'ran').catch((error: unknown) => error),
  );

  expect(refusal).toMatchObject({ details: { reason: 'LEASE_NOT_FOUND' } });
  finish();
  await device;
  await vi.waitFor(expectSessionEnded);
});

test('a refusal after an expired session was torn down claims no dispatch verdict', async () => {
  const { scopeFor, expectSessionEnded } = await sessionWhoseLeaseEnded('expired');
  // It names no lease, so it is refused only once the session and its lease are gone.
  const scope = await scopeFor('press', {
    tenantId: 'tenant-a',
    runId: 'run-1',
    sessionIsolation: 'tenant',
  });

  const refusal = await scope.runLocked(async () => 'ran').catch((error: unknown) => error);

  expectSessionEnded();
  expect(refusal).toBeInstanceOf(Error);
  expect(refusal).not.toHaveProperty('details.dispatched');
});

// Each close holds its own session and the lease end needs both: neither may wait for it there.
test('two closes of sessions sharing a removed lease both finish', async () => {
  const leaseRegistry = new LeaseRegistry();
  const sessionStore = makeSessionStore('agent-device-request-scope-');
  const owner = { tenantId: 'tenant-a', runId: 'run-1' };
  const lease = leaseRegistry.allocateLease(owner);
  const names = ['tenant-a:first', 'tenant-a:second'];
  for (const name of names) {
    sessionStore.publish(
      name,
      makeSession(name, {
        device: { ...LINUX_DEVICE, id: name },
        lease: { ...owner, leaseId: lease.leaseId },
      }),
    );
  }
  leaseRegistry.releaseLease({ ...owner, leaseId: lease.leaseId });
  const executionLocks = getLeaseRegistryExecutionLocks(leaseRegistry);
  const leaseEnd = createLeaseSessionEnd({
    env: process.env,
    sessionStore,
    executionLocks,
    teardownSession: async () => {},
    cleanupSessionlessExecutionHost: async () => {},
  });
  const scopes = await Promise.all(
    names.map(
      async (session) =>
        await createRequestExecutionScope({
          host: createTestHostEnvironment(),
          platformServices: daemonPlatformServicesFixture(),
          claimRecoveryGateway: daemonClaimRecoveryGatewayFixture(),
          trackClaimRecoveryDisposal: () => {},
          deviceRuntimeGateway: unavailableDeviceRuntimeGateway,
          platformRequestScope: platformRequestScopeFixture(),
          req: makeRequest({
            command: 'close',
            session,
            meta: { ...owner, leaseId: lease.leaseId, sessionIsolation: 'tenant' },
          }),
          sessionStore,
          leaseRegistry,
          endSessionsForLease: async (leaseId) => await leaseEnd.end(leaseId, 'LEASE_RELEASED'),
        }),
    ),
  );
  // Both closes queue behind one holder, so both hold their locks before either reaches the end.
  let finish!: () => void;
  const running = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const held = withRequestExecutionLockKeys(
    executionLocks,
    names.flatMap((name) => existingSessionExecutionLockKeys(name, name)),
    async () => await running,
  );
  const closes = scopes.map(
    async (scope) => await scope.runLocked(async () => 'ran').catch((error: unknown) => error),
  );
  await new Promise((resolve) => setImmediate(resolve));
  finish();
  await held;

  for (const refusal of await Promise.all(closes)) {
    expect(refusal).toMatchObject({ details: { reason: 'LEASE_NOT_FOUND' } });
  }
  await vi.waitFor(() => expect(sessionStore.listRefs()).toEqual([]));
});

// Lease commands take no session lock: they must neither wait for the command that holds the session
// nor end it underneath that command.
test('lease_heartbeat on a busy session ends it once that request finishes', async () => {
  const { sessionStore, session, run, holdSession, expectSessionEnded } =
    await sessionWhoseLeaseEnded('released');
  const release = holdSession();

  await run('lease_heartbeat', async () => 'ran');
  expect(sessionStore.get(session.name)).toBeDefined();
  await release();

  await vi.waitFor(expectSessionEnded);
});
