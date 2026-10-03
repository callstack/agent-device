import type { DeviceLease } from '@agent-device/contracts/device';
import type { DeviceInfo } from '@agent-device/kernel/device';
import type { ProviderProfileFieldDeclaration } from '@agent-device/contracts/provider-profile-fields';

export type LimrunPlatform = 'ios' | 'android';

export const LIMRUN_PROVIDER = 'limrun';

/** Limrun reads only the app to preinstall; it picks the instance itself. */
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
