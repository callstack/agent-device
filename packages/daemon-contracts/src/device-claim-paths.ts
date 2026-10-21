import { resolveDeviceClaimRoot } from '@agent-device/host-kit/file';
import crypto from 'node:crypto';
import path from 'node:path';
import type { EnvMap } from '@agent-device/kernel/source-value';
import {
  type AppleOS,
  type DeviceIdentity,
  type DeviceInfo,
  type Platform,
} from '@agent-device/kernel/device';

export function canonicalLocalDeviceKey(device: DeviceInfo | DeviceIdentity): string {
  return formatLocalDeviceKey(
    'family' in device ? device.family : device.platform,
    device.appleOs,
    device.id,
  );
}

function formatLocalDeviceKey(
  platform: Platform,
  appleOs: AppleOS | undefined,
  id: string,
): string {
  return `local:${platform}:${appleOs ?? 'none'}:${id}`;
}

export function resolveDeviceClaimPath(deviceKey: string, env: EnvMap): string {
  const hash = crypto.createHash('sha256').update(deviceKey).digest('hex');
  return path.join(resolveDeviceClaimRoot(env), `${hash}.json`);
}
