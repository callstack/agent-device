import type { EnvMap } from '@agent-device/kernel/source-value';
import type {
  AppleAppDeploymentExecutor,
  MaterializeAppSourceInput,
} from '@agent-device/contracts/app-deployment-runtime';

/**
 * Native Apple executor port. The platform package owns deployment sequencing; this composition
 * adapter loads native mechanics only once an admitted Apple binding invokes an operation.
 */
export function createAppleAppDeploymentExecutor(
  env: Readonly<EnvMap>,
): AppleAppDeploymentExecutor {
  return Object.freeze({
    withInvalidatedAppResolutionCache: async (device, operation) => {
      const { invalidateIosAppResolutionCache } =
        await import('@agent-device/platform-apple/app-resolution');
      return await invalidateIosAppResolutionCache(device, operation);
    },
    prepareArtifact: async (input: MaterializeAppSourceInput, options) => {
      const { prepareIosInstallArtifact } =
        await import('@agent-device/platform-apple/install-artifact');
      return await prepareIosInstallArtifact(input.source, {
        ...options,
        environment: env,
      });
    },
    resolveAppBundleId: async (device, app, options) => {
      const { resolveIosApp } = await import('@agent-device/platform-apple/app-resolution');
      return await resolveIosApp(device, app, options);
    },
  });
}
