import { createTestDeviceInventoryGateways } from '../../__tests__/test-utils/device-inventory-gateways.ts';
import {
  daemonPlatformServicesFixture,
  daemonClaimRecoveryGatewayFixture,
} from './platform-services-fixture.ts';
import { makeIosAppSession } from './support/session-factories.ts';
import { makeSessionStore } from './support/store-factory.ts';
import { buildSessionLeaseFromRequest } from '../lease-context.ts';
import { LeaseRegistry } from '../lease-registry.ts';
import { createRequestHandler } from '../request-router.ts';
import { providerCredentialsFixture } from './support/provider-credentials-fixture.ts';
import { tenantScopedSessionName } from '../session-tenant-scope.ts';
import { lifecycleDeviceRuntimeGateway } from './test-device-runtime-gateway.ts';
import { HUMAN_CONTROL_LEASE_REQUEST, humanControlRequest } from './human-control-fixtures.ts';
import { fakeCreateCommandSurface } from './support/command-surface-fake.ts';

export function createHumanControlHarness() {
  const registry = new LeaseRegistry();
  const lease = registry.allocateLease(HUMAN_CONTROL_LEASE_REQUEST);
  const sessionStore = makeSessionStore('agent-device-human-control-');
  const sessionName = tenantScopedSessionName(lease.tenantId, 'takeover-test');
  sessionStore.publish(
    sessionName,
    makeIosAppSession(sessionName, {
      lease: buildSessionLeaseFromRequest(humanControlRequest(lease), lease),
    }),
  );
  const handleRequest = createRequestHandler({
    createCommandSurface: fakeCreateCommandSurface,
    logPath: '/tmp/agent-device-human-control.log',
    platformServices: daemonPlatformServicesFixture(),
    claimRecoveryGateway: daemonClaimRecoveryGatewayFixture(),
    token: 'test-token',
    sessionStore,
    leaseRegistry: registry,
    providerCredentials: providerCredentialsFixture({}, '/tmp'),
    deviceInventoryGateways: createTestDeviceInventoryGateways(),
    deviceRuntimeGateway: lifecycleDeviceRuntimeGateway,
    trackDownloadableArtifact: () => 'artifact-1',
  });
  return { registry, lease, sessionStore, sessionName, handleRequest };
}
