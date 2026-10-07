import type { AppError, AppErrorCode, AppErrorDetails } from '@agent-device/kernel/errors';

export type ProviderPluginHost = Readonly<{
  env: Readonly<Record<string, string | undefined>>;
  options: Readonly<Record<string, unknown>>;
  clientVersion: string;
  apple: Readonly<{
    archiveDirectory(options: {
      sourceDirectory: string;
      entryName: string;
      archivePath: string;
    }): Promise<void>;
    resolveAppAlias(app: string): Promise<string>;
    readBundleAppName(appPath: string): Promise<string | undefined>;
  }>;
  createError(code: AppErrorCode, message: string, details?: AppErrorDetails): AppError;
}>;
