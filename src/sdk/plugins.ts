import type { AppError, AppErrorCode, AppErrorDetails } from '@agent-device/kernel/errors';

export type ProviderPluginHost = Readonly<{
  env: Readonly<Record<string, string | undefined>>;
  options: Readonly<Record<string, unknown>>;
  createError(code: AppErrorCode, message: string, details?: AppErrorDetails): AppError;
}>;
