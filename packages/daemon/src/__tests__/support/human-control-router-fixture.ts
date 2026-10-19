import { createTestHostEnvironment } from '@agent-device/test-kit';
import { createTestDeviceInventoryGateways } from '@agent-device/device-selection/inventory-gateways-fixtures';
import {
  daemonPlatformServicesFixture,
  daemonClaimRecoveryGatewayFixture,
} from './platform-services-fixture.ts';
import { makeIosAppSession } from './session-factories.ts';
import { makeSessionStore } from './store-factory.ts';
import { buildSessionLeaseFromRequest } from '../../core/lease-context.ts';
import { LeaseRegistry } from '../../resources/lease-registry.ts';
import { createRequestHandler } from '../../server/request-router.ts';
import { providerCredentialsFixture } from './provider-credentials-fixture.ts';
import { tenantScopedSessionName } from '../../core/session-tenant-scope.ts';
import { lifecycleDeviceRuntimeGateway } from './test-device-runtime-gateway.ts';
import { HUMAN_CONTROL_LEASE_REQUEST, humanControlRequest } from './human-control-fixtures.ts';
import { fakeCreateCommandSurface } from './command-surface-fake.ts';
import { clearAndroidObservationFixture } from './android-observation-fixture.ts';
import { platformResourceCleanupFixture } from './platform-resource-cleanup-fixture.ts';

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
    host: createTestHostEnvironment(),
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
    androidObservation: clearAndroidObservationFixture,
    platformResourceCleanup: platformResourceCleanupFixture(),
    trackDownloadableArtifact: () => 'artifact-1',
  });
  return { registry, lease, sessionStore, sessionName, handleRequest };
}
