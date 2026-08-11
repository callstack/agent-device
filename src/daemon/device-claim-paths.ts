import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {
  deviceFieldsFromPublicPlatform,
  isAppleOs,
  type AppleOS,
  type DeviceInfo,
  type PublicPlatform,
} from '@agent-device/kernel/device';

export function canonicalLocalDeviceKey(device: DeviceInfo): string {
  return formatLocalDeviceKey(device.platform, device.appleOs, device.id);
}

export function isCanonicalPersistedLocalDeviceKey(
  device: { platform: PublicPlatform; appleOs?: AppleOS; id: string },
  deviceKey: string,
): boolean {
  const internal = deviceFieldsFromPublicPlatform(device.platform);
  if (device.appleOs !== undefined) {
    return deviceKey === formatLocalDeviceKey(internal.platform, device.appleOs, device.id);
  }
  const prefix = `local:${internal.platform}:`;
  const suffix = `:${device.id}`;
  if (!deviceKey.startsWith(prefix) || !deviceKey.endsWith(suffix)) return false;
  const appleOs = deviceKey.slice(prefix.length, -suffix.length);
  if (device.platform === 'macos') return appleOs === 'none' || appleOs === 'macos';
  if (device.platform === 'ios') {
    return appleOs === 'none' || (isAppleOs(appleOs) && appleOs !== 'macos');
  }
  return appleOs === 'none';
}

function formatLocalDeviceKey(
  platform: DeviceInfo['platform'],
  appleOs: AppleOS | undefined,
  id: string,
): string {
  return `local:${platform}:${appleOs ?? 'none'}:${id}`;
}

export function resolveDeviceClaimRoot(): string {
  const override = process.env.AGENT_DEVICE_CLAIMS_DIR?.trim();
  return override
    ? path.resolve(override)
    : path.join(os.homedir(), '.agent-device', 'device-claims');
}

export function resolveDeviceClaimPath(deviceKey: string): string {
  const hash = crypto.createHash('sha256').update(deviceKey).digest('hex');
  return path.join(resolveDeviceClaimRoot(), `${hash}.json`);
}
