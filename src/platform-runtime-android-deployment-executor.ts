import type {
  AndroidAppDeploymentExecutor,
  MaterializeAppSourceInput,
} from '@agent-device/contracts/app-deployment-runtime';
import { loadAndroidMechanics } from './platform-runtime-android-mechanics.ts';

/** Android deployment adapter; native command construction remains package-owned. */
export function createAndroidAppDeploymentExecutor(): AndroidAppDeploymentExecutor {
  return Object.freeze({
    bundletoolJar: process.env.AGENT_DEVICE_BUNDLETOOL_JAR?.trim() || undefined,
    withInvalidatedAppResolutionCache: async (device, operation) => {
      const { withAndroidAppResolutionCacheInvalidated } = await loadAndroidMechanics();
      return await withAndroidAppResolutionCacheInvalidated(device, operation);
    },
    prepareArtifact: async (input: MaterializeAppSourceInput, options) => {
      const { prepareAndroidInstallArtifact } = await loadAndroidMechanics();
      return await prepareAndroidInstallArtifact(input.source, options);
    },
    resolveAppPackage: async (device, app) => {
      const { resolveAndroidApp } = await loadAndroidMechanics();
      const resolved = await resolveAndroidApp(device, app);
      if (resolved.type === 'intent') {
        const { AppError } = await import('@agent-device/kernel/errors');
        throw new AppError('INVALID_ARGS', 'App uninstall requires a package name, not an intent');
      }
      return resolved.value;
    },
  });
}
