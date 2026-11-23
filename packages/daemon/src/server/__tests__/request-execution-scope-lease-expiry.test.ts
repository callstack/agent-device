import { createLeaseSessionEnd } from '../lease-session-end.ts';
import { expect, test, vi } from 'vitest';
import {
  daemonPlatformServicesFixture,
  daemonClaimRecoveryGatewayFixture,
} from '../../__tests__/support/platform-services-fixture.ts';
import { makeSession } from '../../__tests__/support/session-factories.ts';
import {
  LINUX_DEVICE,
  createTestHostEnvironment,
  bindTestCommandHost,
} from '@agent-device/test-kit';
import { makeSessionStore } from '../../__tests__/support/store-factory.ts';
import { LeaseRegistry } from '../../resources/lease-registry.ts';
import {
  getLeaseRegistryExecutionLocks,
  createRequestExecutionScope,
} from '../request-execution-scope.ts';
import { teardownSessionResources } from '../../sessions/session-teardown.ts';
import type { DaemonRequest } from '../../core/daemon-request.ts';
import {
  platformRequestScopeFixture,
  unavailableDeviceRuntimeGateway,
} from '../../__tests__/support/unavailable-device-runtime-gateway.ts';

bindTestCommandHost();

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

test.each(['rebuild', 'retire'] as const)(
  'scoped lease expiry preserves a public-name session and a %s during held teardown',
  async (change) => {
    let now = 1_000;
    const store = makeSessionStore('request-scope-lease-lifetime-');
    const leases = new LeaseRegistry({
      defaultLeaseTtlMs: 10,
      minLeaseTtlMs: 1,
      now: () => now,
      onLeaseExpired: (ended) => {
        void leaseSessionEnd.end(ended.leaseId, 'LEASE_EXPIRED');
      },
    });
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
          backend: lease.backend,
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
    const leaseSessionEnd = createLeaseSessionEnd({
      env: {},
      sessionStore: store,
      executionLocks: getLeaseRegistryExecutionLocks(leases),
      cleanupSessionlessExecutionHost: async () => {},
      teardownSession: async (ref) =>
        await teardownSessionResources({
          appLog: 'run',
          ref,
          sessionStore: store,
          platformCleanup: {
            stopSnapshotHelper,
            closeManagedBrowser: async () => {},
            cleanupSessionlessExecutionHost: async () => {},
            retainExecutionHostAfterClose: () => false,
          },
        }),
    });
    const scope = await createRequestExecutionScope({
      host: createTestHostEnvironment(),
      platformServices: daemonPlatformServicesFixture(),
      claimRecoveryGateway: daemonClaimRecoveryGatewayFixture(),
      trackClaimRecoveryDisposal: () => {},
      deviceRuntimeGateway: unavailableDeviceRuntimeGateway,
      platformRequestScope: platformRequestScopeFixture(),
      req: makeRequest({
        session: address,
        flags: { session: address },
        meta: { leaseId: lease.leaseId },
      }),
      sessionStore: store,
      leaseRegistry: leases,
      leaseSessionEnd,
    });
    expect(scope.sessionName).toBe(address);
    const running = expect(scope.runLocked(async () => 'ran')).rejects.toMatchObject({
      details: { reason: 'LEASE_NOT_FOUND' },
    });
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
    await running;
    expect(stopSnapshotHelper).toHaveBeenCalledExactlyOnceWith(original.session.device);
    expect(store.requireCurrent(decoy)).toBe(decoy.session);
    if (successor) expect(store.requireCurrent(successor)).toBe(successor.session);
    else expect(store.lookup(address)).toBeUndefined();
  },
);
