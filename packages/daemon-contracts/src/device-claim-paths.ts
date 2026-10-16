import crypto from 'node:crypto';
import os from 'node:os';
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

export function resolveDeviceClaimRoot(env: EnvMap): string {
  const override = env.AGENT_DEVICE_CLAIMS_DIR?.trim();
  return override
    ? path.resolve(override)
    : path.join(os.homedir(), '.agent-device', 'device-claims');
}

export function resolveDeviceClaimPath(deviceKey: string, env: EnvMap): string {
  const hash = crypto.createHash('sha256').update(deviceKey).digest('hex');
  return path.join(resolveDeviceClaimRoot(env), `${hash}.json`);
}
