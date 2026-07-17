import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

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
