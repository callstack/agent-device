import type {
  AndroidAppDeploymentExecutor,
  MaterializeAppSourceInput,
} from '@agent-device/contracts/app-deployment-runtime';

/**
 * Temporary Android migration port. The package owns native command construction; this adapter
 * retains only artifact preparation and fuzzy app resolution until those legacy owners move.
 */
export function createAndroidAppDeploymentExecutor(): AndroidAppDeploymentExecutor {
  return Object.freeze({
    bundletoolJar: process.env.AGENT_DEVICE_BUNDLETOOL_JAR?.trim() || undefined,
    withInvalidatedAppResolutionCache: async (device, operation) => {
      const { withAndroidAppResolutionCacheInvalidated } =
        await import('./platforms/android/app-deployment-resolution.ts');
      return await withAndroidAppResolutionCacheInvalidated(device, operation);
    },
    prepareArtifact: async (input: MaterializeAppSourceInput, options) => {
      const { prepareAndroidInstallArtifact } =
        await import('./platforms/android/install-artifact.ts');
      return await prepareAndroidInstallArtifact(input.source, options);
    },
    resolveAppPackage: async (device, app) => {
      const { resolveAndroidApp } =
        await import('./platforms/android/app-deployment-resolution.ts');
      const resolved = await resolveAndroidApp(device, app);
      if (resolved.type === 'intent') {
        const { AppError } = await import('@agent-device/kernel/errors');
        throw new AppError('INVALID_ARGS', 'App uninstall requires a package name, not an intent');
      }
      return resolved.value;
    },
  });
}
