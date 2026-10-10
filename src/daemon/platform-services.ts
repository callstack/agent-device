import type { AppleSessionObservation } from '@agent-device/contracts/apple-session-observation';
import type { DeviceBootObservationService } from '@agent-device/contracts/device-boot';
import type { SessionSurface } from '@agent-device/contracts/session';
import type { DeviceInfo } from '@agent-device/kernel/device';

/**
 * Concrete local readiness for one device, answering "does this local leaf have a readiness step,
 * and did it settle?" — the boolean keeps the daemon's TTL cache honest without a platform branch.
 */
export type EnsureLocalDeviceReady = (device: DeviceInfo) => Promise<boolean>;

/**
 * Root-composed platform services the daemon asks of the host machine for work that binds no
 * device runtime. Every member is an already-published neutral contract over mechanics the daemon
 * must never name or load itself: concrete local readiness, boot-time and runner-session
 * observation, and open-target classification. Device execution is NOT in this port and never
 * enters it (ADR 0019): it goes through the request-bound runtime binding
 * (`RequestExecutionScope.bindDevice`), whose owner facts stay the only admission authority.
 */
export type DaemonPlatformServices = Readonly<{
  appleSessionObservation: AppleSessionObservation;
  deviceBootObservation: DeviceBootObservationService;
  ensureLocalDeviceReady: EnsureLocalDeviceReady;
  resolveRequestedOpenSurface(params: {
    device: DeviceInfo;
    surfaceFlag: string | undefined;
    openTarget: string | undefined;
    existingSurface?: SessionSurface;
  }): SessionSurface;
  validateOpenRelaunchTarget(params: {
    target: string | undefined;
    platform: string | undefined;
    surface?: SessionSurface;
  }): Promise<string | undefined>;
  resolveSessionAppBundleIdForTarget(
    device: DeviceInfo,
    openTarget: string | undefined,
    currentAppBundleId: string | undefined,
  ): Promise<string | undefined>;
}>;
