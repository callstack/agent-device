import { bindTestCommandHost, createTestHostEnvironment } from '@agent-device/test-kit';
import { expect, test, vi } from 'vitest';
import {
  daemonClaimRecoveryGatewayFixture,
  daemonPlatformServicesFixture,
} from '../../__tests__/support/platform-services-fixture.ts';
import { makeIosSession } from '../../__tests__/support/session-factories.ts';
import { makeSessionStore } from '../../__tests__/support/store-factory.ts';
import {
  platformRequestScopeFixture,
  unavailableDeviceRuntimeGateway,
} from '../../__tests__/support/unavailable-device-runtime-gateway.ts';
import type { DaemonRequest } from '../../core/daemon-request.ts';
import { LeaseRegistry } from '../../resources/lease-registry.ts';
import { createRequestExecutionScope } from '../request-execution-scope.ts';

bindTestCommandHost();

function createTestRequestScope(
  params: Pick<
    Parameters<typeof createRequestExecutionScope>[0],
    'req' | 'sessionStore' | 'leaseRegistry'
  >,
) {
  return createRequestExecutionScope({
    host: createTestHostEnvironment(),
    ...params,
    platformServices: daemonPlatformServicesFixture(),
    claimRecoveryGateway: daemonClaimRecoveryGatewayFixture(),
    deviceRuntimeGateway: unavailableDeviceRuntimeGateway,
    platformRequestScope: platformRequestScopeFixture(),
  });
}

function makeRequest(overrides: Partial<DaemonRequest> = {}): DaemonRequest {
  return {
    token: 'test-token',
    session: 'default',
    command: 'snapshot',
    positionals: [],
    ...overrides,
  };
}

function publishProviderLeasedDefaultSession(
  sessionStore: ReturnType<typeof makeSessionStore>,
  leaseRegistry: LeaseRegistry,
): void {
  const lease = leaseRegistry.allocateLease({
    tenantId: 'tenant-a',
    runId: 'run-1',
    leaseProvider: 'proxy',
    clientId: 'client-a',
    deviceKey: 'ios:sim-1',
  });
  sessionStore.publish(
    'default',
    makeIosSession('default', {
      lease: {
        leaseId: lease.leaseId,
        tenantId: lease.tenantId,
        runId: lease.runId,
        leaseBackend: lease.backend,
        leaseProvider: 'proxy',
        clientId: 'client-a',
        deviceKey: 'ios:sim-1',
        expiresAt: lease.expiresAt,
      },
    }),
  );
}

test.each(['snapshot', 'artifacts', 'events', 'logs', 'doctor', 'capabilities'])(
  'an unnamed %s cannot reach the provider lease another caller left on the default session',
  async (command) => {
    const sessionStore = makeSessionStore('agent-device-request-scope-');
    const leaseRegistry = new LeaseRegistry();
    publishProviderLeasedDefaultSession(sessionStore, leaseRegistry);
    const dispatch = vi.fn(async () => 'ran');

    const run = async () => {
      const scope = await createTestRequestScope({
        req: makeRequest({ command, internal: { sessionOmitted: true } }),
        sessionStore,
        leaseRegistry,
      });
      return await scope.runLocked(dispatch);
    };

    await expect(run()).rejects.toMatchObject({
      code: 'INVALID_ARGS',
      details: { reason: 'REMOTE_SESSION_REQUIRED', leaseProvider: 'proxy' },
    });
    expect(dispatch).not.toHaveBeenCalled();
  },
);

test('an unnamed command queued behind an open is refused once that open leaves a provider lease', async () => {
  const sessionStore = makeSessionStore('agent-device-request-scope-');
  const leaseRegistry = new LeaseRegistry();
  const dispatch = vi.fn(async () => 'ran');
  const scope = await createTestRequestScope({
    req: makeRequest({ internal: { sessionOmitted: true } }),
    sessionStore,
    leaseRegistry,
  });

  publishProviderLeasedDefaultSession(sessionStore, leaseRegistry);

  await expect(scope.runLocked(dispatch)).rejects.toMatchObject({
    code: 'INVALID_ARGS',
    details: { reason: 'REMOTE_SESSION_REQUIRED', leaseProvider: 'proxy' },
  });
  expect(dispatch).not.toHaveBeenCalled();
});

test.each(['session_list', 'devices', 'release_materialized_paths'])(
  'an unnamed %s still answers while the default session holds a provider lease',
  async (command) => {
    const sessionStore = makeSessionStore('agent-device-request-scope-');
    const leaseRegistry = new LeaseRegistry();
    publishProviderLeasedDefaultSession(sessionStore, leaseRegistry);

    const scope = await createTestRequestScope({
      req: makeRequest({ command, internal: { sessionOmitted: true } }),
      sessionStore,
      leaseRegistry,
    });

    await expect(scope.runLocked(async () => 'ran')).resolves.toBe('ran');
  },
);
