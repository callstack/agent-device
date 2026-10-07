import { AppError } from '@agent-device/kernel/errors';
import { execFailureDetails, runCmd } from '@agent-device/host-kit/command';
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
    apple: Object.freeze({
      archiveDirectory: async ({ sourceDirectory, entryName, archivePath }) => {
        const args = ['-qr', archivePath, entryName];
        const result = await runCmd('zip', args, { cwd: sourceDirectory, timeoutMs: 120_000 });
        if (result.exitCode !== 0) {
          throw new AppError('COMMAND_FAILED', 'Failed to package iOS app for provider install', {
            command: ['zip', ...args].join(' '),
            ...execFailureDetails(result),
          });
        }
      },
      resolveAppAlias: async (app) => {
        const { resolveIosAppAlias } = await import('@agent-device/platform-apple/app-resolution');
        return await resolveIosAppAlias(app);
      },
      readBundleAppName: async (appPath) => {
        const { readIosBundleInfo } = await import('@agent-device/platform-apple/install-artifact');
        return (await readIosBundleInfo(appPath)).appName;
      },
    }),
  } satisfies ProviderPluginHost);
}
