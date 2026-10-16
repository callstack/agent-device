import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

/**
 * Where a device claim is stored on disk: `<claims dir>/<sha256(deviceKey)>.json`, with the claims
 * dir overridable through `AGENT_DEVICE_CLAIMS_DIR`. Restated here so tests pin the layout the CLI
 * and the daemon share instead of re-importing the production resolver.
 */
export function deviceClaimFilePath(deviceKey: string): string {
  const override = process.env.AGENT_DEVICE_CLAIMS_DIR?.trim();
  if (override && !path.isAbsolute(override)) {
    throw new Error(`AGENT_DEVICE_CLAIMS_DIR must be an absolute path: ${override}`);
  }
  const root = override || path.join(os.homedir(), '.agent-device', 'device-claims');
  return path.join(root, `${crypto.createHash('sha256').update(deviceKey).digest('hex')}.json`);
}
