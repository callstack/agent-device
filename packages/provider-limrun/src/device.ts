import { createHash } from 'node:crypto';
import type { DeviceLease } from '@agent-device/contracts/device';
import type { DeviceInfo } from '@agent-device/kernel/device';
import type { ReasonTable } from '@agent-device/kernel/errors';
import type { ProviderProfileFieldDeclaration } from '@agent-device/contracts/provider-profile-fields';

/**
 * Every `details.reason` the Limrun provider publishes, keyed by what the failure means. Each
 * refusal site reads a row here, so the plugin's wire vocabulary has one owner; the modules that
 * classify those failures all load this one. `provider-instance-ended` is the lease vocabulary and
 * stays with the lease table in `@agent-device/contracts/lease-scope`.
 */
export const LIMRUN_PROVIDER_REASONS = {
  // A release could not confirm Limrun deleted the instance, so it may still be billed.
  instanceDeleteUnconfirmed: { reason: 'limrun_instance_delete_unconfirmed' },
  // The lease was released while its instance was still being prepared for the allocation.
  leaseReleasedMidAllocation: { reason: 'limrun_lease_released_mid_allocation' },
  // The lease holds no live session, so the command that addresses it has nothing to act on.
  leaseNotLive: { reason: 'limrun_lease_not_live' },
  // This runtime is shut down, so it refuses to allocate a lease into it.
  runtimeShutDown: { reason: 'limrun_runtime_shut_down' },
  // The instance stopped answering, so its app state cannot be read.
  instanceUnreachable: { reason: 'limrun_instance_unreachable' },
  // The ADB tunnel of this lease was already cleaned up, so nothing can be typed over it.
  adbTunnelCleanedUp: { reason: 'limrun_adb_tunnel_cleaned_up' },
  // The app-sync session of this lease has ended, so no further sync runs on it.
  appSyncRetired: { reason: 'limrun_app_sync_retired' },
  // Syncing the app to the instance stopped with nothing installed.
  appSyncFailed: { reason: 'limrun_app_sync_failed' },
} as const satisfies ReasonTable<'limrun provider'>;

export type LimrunPlatform = 'ios' | 'android';

export const LIMRUN_PROVIDER = 'limrun';

/**
 * Limrun reads the app to preinstall and the network capture settings; it picks the instance
 * itself.
 */
export const LIMRUN_PROFILE_FIELDS: ProviderProfileFieldDeclaration = {
  provider: LIMRUN_PROVIDER,
  label: 'Limrun',
  fields: {
    providerApp: 'consumed',
    providerOsVersion: 'refused',
    providerDeviceType: 'refused',
    providerProject: 'refused',
    providerBuild: 'refused',
    providerSessionName: 'refused',
    providerDeviceOrientation: 'refused',
    providerGeoLocation: 'refused',
    providerTimezone: 'refused',
    providerAppiumVersion: 'refused',
    providerLanguage: 'refused',
    providerLocale: 'refused',
    providerNetworkProfile: 'refused',
    providerCustomNetwork: 'refused',
    providerNoResignApp: 'refused',
    providerNetworkLogs: 'consumed',
    providerNetworkHosts: 'consumed',
    awsProjectArn: 'refused',
    awsDeviceArn: 'refused',
    awsAppArn: 'refused',
    awsRegion: 'refused',
    awsInteractionMode: 'refused',
  },
};

const LIMRUN_DEVICE_ID_PREFIX = LIMRUN_PROVIDER;

export function platformForLimrunLeaseBackend(backend: string): LimrunPlatform | undefined {
  if (backend === 'ios-instance') return 'ios';
  if (backend === 'android-instance') return 'android';
  return undefined;
}

export function buildLimrunDevice(
  platform: LimrunPlatform,
  lease: DeviceLease,
  instanceId: string,
): DeviceInfo {
  return {
    platform: platform === 'ios' ? 'apple' : 'android',
    ...(platform === 'ios' ? { appleOs: 'ios' as const } : {}),
    id: limrunDeviceId(platform, lease.leaseId),
    name: `Limrun ${platform} ${instanceId.slice(0, 8)}`,
    kind: platform === 'ios' ? 'simulator' : 'emulator',
    target: 'mobile',
    booted: true,
  };
}

/**
 * A stable local id for an attached instance, derived from the API URL that identifies it, so the
 * same instance keeps the same id across daemon restarts.
 */
export function attachedLimrunInstanceId(apiUrl: string): string {
  return `attached-${createHash('sha256').update(apiUrl).digest('hex').slice(0, 12)}`;
}

export function parseLimrunDeviceId(
  value: string,
): { platform: LimrunPlatform; leaseId: string } | undefined {
  const [prefix, platform, leaseId] = value.split(':');
  if (prefix !== LIMRUN_DEVICE_ID_PREFIX) return undefined;
  if (platform !== 'ios' && platform !== 'android') return undefined;
  if (!leaseId) return undefined;
  return { platform, leaseId };
}

function limrunDeviceId(platform: LimrunPlatform, leaseId: string): string {
  return `${LIMRUN_DEVICE_ID_PREFIX}:${platform}:${leaseId}`;
}

/**
 * Whether `device` is one Limrun app logs recognize: an id this module itself would have built,
 * on the device shape that id's platform implies. Shared by both the owner module
 * (`app-log-runtime.ts`) and its facts module (`facts-runtime.ts`) so device-identity support
 * has exactly one definition regardless of which one asks.
 */
export function isSupportedLimrunAppLogDevice(device: DeviceInfo): boolean {
  const parsed = parseLimrunDeviceId(device.id);
  if (!parsed || device.target !== 'mobile') return false;
  return parsed.platform === 'ios'
    ? isSupportedLimrunIosDevice(device)
    : isSupportedLimrunAndroidDevice(device);
}

function isSupportedLimrunIosDevice(device: DeviceInfo): boolean {
  return (
    device.platform === 'apple' &&
    device.appleOs === 'ios' &&
    device.kind === 'simulator' &&
    device.iosPhysicalDeviceBackend === undefined
  );
}

function isSupportedLimrunAndroidDevice(device: DeviceInfo): boolean {
  return (
    device.platform === 'android' &&
    device.appleOs === undefined &&
    device.kind === 'emulator' &&
    device.iosPhysicalDeviceBackend === undefined
  );
}
