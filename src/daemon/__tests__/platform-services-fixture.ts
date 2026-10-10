import { createDaemonPlatformServices } from '../../platform-runtime-daemon-services.ts';
import { createClaimRecoveryGateway } from '../../platform-runtime-claim-recovery.ts';
import type { DaemonPlatformServices } from '../platform-services.ts';
import type { ClaimRecoveryGatewayFactory } from '../device/claim-recovery-gateway.ts';

/**
 * The port the production composition root builds, handed to a test the same way the shared router
 * fixture hands the real resource-cleanup capability: tests that exercise command behaviour rather
 * than readiness or observation policy keep seeing the real adapters, and a test that cares about
 * one ask replaces just that member — a readiness spy overrides `ensureLocalDeviceReady` rather
 * than mocking a platform module behind the port.
 */
export function daemonPlatformServicesFixture(
  overrides: Partial<DaemonPlatformServices> = {},
): DaemonPlatformServices {
  return Object.freeze({ ...createDaemonPlatformServices(), ...overrides });
}

/**
 * The recovery-gateway half of root composition, same rule as the services above: tests that
 * route a stale claim see the real composed gateway, and a test that cares about composition
 * passes its own factory.
 */
export function daemonClaimRecoveryGatewayFixture(): ClaimRecoveryGatewayFactory {
  return createClaimRecoveryGateway;
}
