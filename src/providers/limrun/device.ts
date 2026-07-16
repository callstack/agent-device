import type { DeviceLease } from '../../daemon/lease-registry.ts';
import type { DeviceInfo } from '../../kernel/device.ts';

export type LimrunPlatform = 'ios' | 'android';

export const LIMRUN_PROVIDER = 'limrun';

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
