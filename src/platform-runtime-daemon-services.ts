import { appleSessionObservation } from './platform-runtime-apple-resources.ts';
import { deviceBootObservation } from './platform-runtime-device-boot.ts';
import { ensureLocalPlatformDeviceReady } from './platform-runtime-device-ready.ts';
import {
  resolveRequestedOpenSurface,
  resolveSessionAppBundleIdForTarget,
  validateOpenRelaunchTarget,
} from './platform-runtime-open-target.ts';
import type { DaemonPlatformServices } from './daemon/platform-services.ts';

/**
 * Root composition of the daemon's platform-services port (ADR 0019 section 1). Each member is
 * already the neutral contract the daemon consumes; this module is what names the concrete
 * adapters, so no daemon file has to. Device execution never enters here — it reaches the device
 * through the request-bound runtime binding, whose owner facts stay the only admission authority.
 */
export function createDaemonPlatformServices(): DaemonPlatformServices {
  return Object.freeze({
    appleSessionObservation,
    deviceBootObservation,
    ensureLocalDeviceReady: ensureLocalPlatformDeviceReady,
    resolveRequestedOpenSurface,
    validateOpenRelaunchTarget,
    resolveSessionAppBundleIdForTarget,
  });
}
