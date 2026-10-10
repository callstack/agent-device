import { createDaemonPlatformServices } from '../../platform-runtime-daemon-services.ts';
import type { DaemonPlatformServices } from '../platform-services.ts';

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
