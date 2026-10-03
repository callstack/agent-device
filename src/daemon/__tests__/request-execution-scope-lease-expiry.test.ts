import { expect, test, vi } from 'vitest';
import { makeSession } from '../../__tests__/test-utils/session-factories.ts';
import { LINUX_DEVICE } from '../../__tests__/test-utils/device-fixtures.ts';
import { makeSessionStore } from '../../__tests__/test-utils/store-factory.ts';
import { LeaseRegistry } from '../lease-registry.ts';
import { createRequestExecutionScope } from '../request-execution-scope.ts';
import type { DaemonRequest } from '../daemon-request.ts';

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
  sessionStore.set(
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
