import { AppError } from '@agent-device/kernel/errors';
import { readVersion } from '@agent-device/host-kit/version';
import type { ProviderPluginHost } from '../sdk/plugins.ts';

export function createPluginHost(
  env: NodeJS.ProcessEnv,
  options: Record<string, unknown> | undefined,
): ProviderPluginHost {
  return Object.freeze({
    env: Object.freeze({ ...env }),
    options: Object.freeze({ ...options }),
    clientVersion: readVersion(),
    createError: (code, message, details) => new AppError(code, message, details),
  } satisfies ProviderPluginHost);
}
