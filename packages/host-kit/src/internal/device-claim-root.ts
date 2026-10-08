import os from 'node:os';
import path from 'node:path';
import { AppError } from '@agent-device/kernel/errors';
import type { EnvMap } from '@agent-device/kernel/source-value';

export function resolveDeviceClaimRoot(env: EnvMap): string {
  const override = env.AGENT_DEVICE_CLAIMS_DIR?.trim();
  if (!override) return path.join(os.homedir(), '.agent-device', 'device-claims');
  // The store is shared by every daemon on the host, so a directory that depends on where one of
  // them happened to start is not a place they can agree on.
  if (!path.isAbsolute(override)) {
    throw new AppError(
      'INVALID_ARGS',
      `AGENT_DEVICE_CLAIMS_DIR must be an absolute path: ${override}`,
      {
        reason: 'relative_claims_dir',
      },
    );
  }
  return path.resolve(override);
}
