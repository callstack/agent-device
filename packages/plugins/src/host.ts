import { AppError, type AppErrorCode, type AppErrorDetails } from '@agent-device/kernel/errors';
import { readVersion } from '@agent-device/host-kit/version';

export type ProviderPluginHost = Readonly<{
  env: Readonly<Record<string, string | undefined>>;
  options: Readonly<Record<string, unknown>>;
  clientVersion: string;
  createError(code: AppErrorCode, message: string, details?: AppErrorDetails): AppError;
}>;

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
