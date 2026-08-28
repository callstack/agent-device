import { AppError } from '@agent-device/kernel/errors';
import type { DoublespeedRuntimeDependencies } from '@agent-device/provider-doublespeed';
import { execFailureDetails, runCmd } from './utils/exec.ts';
import { readVersion } from './utils/version.ts';

export function createDoublespeedRuntimeDependencies(): DoublespeedRuntimeDependencies {
  return {
    clientVersion: readVersion(),
    host: {
      archiveDirectory: async ({ sourceDirectory, entryName, archivePath }) => {
        const args = ['-qr', archivePath, entryName];
        const result = await runCmd('zip', args, {
          cwd: sourceDirectory,
          timeoutMs: 120_000,
        });
        if (result.exitCode !== 0) {
          throw new AppError(
            'COMMAND_FAILED',
            'Failed to package iOS .app for Doublespeed install',
            {
              command: ['zip', ...args].join(' '),
              ...execFailureDetails(result),
            },
          );
        }
      },
    },
    ios: {
      resolveAppAlias: async (app) => {
        const { resolveIosAppAlias } = await import('./platforms/apple/core/app-resolution.ts');
        return resolveIosAppAlias(app);
      },
      readBundleAppName: async (appPath) => {
        const { readIosBundleInfo } = await import('./platforms/apple/core/install-artifact.ts');
        return (await readIosBundleInfo(appPath)).appName;
      },
    },
  };
}
