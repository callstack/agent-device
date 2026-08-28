import { createTestDeviceInventoryGateways } from '../../__tests__/test-utils/device-inventory-gateways.ts';
import { makeIosAppSession } from '../../__tests__/test-utils/session-factories.ts';
import { makeSessionStore } from '../../__tests__/test-utils/store-factory.ts';
import { buildSessionLeaseFromRequest } from '../lease-context.ts';
import { LeaseRegistry } from '../lease-registry.ts';
import { createRequestHandler } from '../request-router.ts';
import { tenantScopedSessionName } from '../session-tenant-scope.ts';
import { lifecycleDeviceRuntimeGateway } from './test-device-runtime-gateway.ts';
import { HUMAN_CONTROL_LEASE_REQUEST, humanControlRequest } from './human-control-fixtures.ts';

export function createHumanControlHarness() {
  const registry = new LeaseRegistry();
  const lease = registry.allocateLease(HUMAN_CONTROL_LEASE_REQUEST);
  const sessionStore = makeSessionStore('agent-device-human-control-');
  const sessionName = tenantScopedSessionName(lease.tenantId, 'takeover-test');
  sessionStore.set(
    sessionName,
    makeIosAppSession(sessionName, {
      lease: buildSessionLeaseFromRequest(humanControlRequest(lease), lease),
    }),
  );
  const handleRequest = createRequestHandler({
    logPath: '/tmp/agent-device-human-control.log',
    token: 'test-token',
    sessionStore,
    leaseRegistry: registry,
    deviceInventoryGateways: createTestDeviceInventoryGateways(),
    deviceRuntimeGateway: lifecycleDeviceRuntimeGateway,
    trackDownloadableArtifact: () => 'artifact-1',
  });
  return { registry, lease, sessionStore, sessionName, handleRequest };
}
