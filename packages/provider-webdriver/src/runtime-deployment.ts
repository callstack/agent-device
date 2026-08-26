import type {
  ProviderDeviceInstallOptions,
  ProviderDeviceInstallResult,
} from '@agent-device/contracts/device';
import type {
  AppDeploymentInput,
  AppDeploymentResult,
  DeployMaterializedAppInput,
} from '@agent-device/contracts/app-deployment-runtime';
import type { RuntimeOperationFact } from '@agent-device/contracts/platform-runtime';
import { publicPlatformString, type DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import { capabilitySupported, unsupportedCapabilityMessage } from './capabilities.ts';
import { providerInstallResult } from './runtime-helpers.ts';
import type { CloudWebDriverUploadApp } from './runtime.ts';
import type { WebDriverProviderSession } from './runtime-session.ts';

export type WebDriverDeploymentRuntime = Readonly<{
  fact(device: DeviceInfo): RuntimeOperationFact;
  installApp(
    device: DeviceInfo,
    app: string,
    appPath: string,
    options?: ProviderDeviceInstallOptions,
    signal?: AbortSignal,
  ): Promise<ProviderDeviceInstallResult | undefined>;
  installInstallablePath(
    device: DeviceInfo,
    installablePath: string,
    options?: ProviderDeviceInstallOptions,
    signal?: AbortSignal,
  ): Promise<ProviderDeviceInstallResult | undefined>;
  deployApp(
    device: DeviceInfo,
    input: AppDeploymentInput,
    signal: AbortSignal,
  ): Promise<AppDeploymentResult>;
  deployMaterializedApp(
    device: DeviceInfo,
    input: DeployMaterializedAppInput,
    signal: AbortSignal,
  ): Promise<AppDeploymentResult>;
}>;

export function createWebDriverDeploymentRuntime(
  options: Readonly<{
    provider: string;
    uploadApp?: CloudWebDriverUploadApp;
    findSessionForDevice(device: DeviceInfo): WebDriverProviderSession | undefined;
  }>,
): WebDriverDeploymentRuntime {
  const installApp = async (
    device: DeviceInfo,
    app: string,
    appPath: string,
    installOptions?: ProviderDeviceInstallOptions,
    signal?: AbortSignal,
  ): Promise<ProviderDeviceInstallResult | undefined> => {
    const session = options.findSessionForDevice(device);
    if (!session) return undefined;
    const upload = await uploadAppIfNeeded(
      options,
      session,
      device,
      app,
      appPath,
      installOptions,
      signal,
    );
    await session.client.installApp(upload?.appReference ?? appPath, signal);
    return providerInstallResult(upload, installOptions);
  };
  return Object.freeze({
    fact: (device) => deploymentFact(options.findSessionForDevice(device)),
    installApp,
    installInstallablePath: async (device, installablePath, installOptions, signal) =>
      await installApp(device, '', installablePath, installOptions, signal),
    deployApp: async (device, input, signal) =>
      deploymentResult(
        await installApp(
          device,
          input.app,
          input.appPath,
          {
            relaunch: input.replaceExisting,
            appIdentifierHint: input.app,
            packageNameHint: input.app,
          },
          signal,
        ),
        input.app,
      ),
    deployMaterializedApp: async (device, input, signal) =>
      deploymentResult(
        await installApp(
          device,
          '',
          input.artifact.installablePath,
          {
            appIdentifierHint: input.artifact.bundleId,
            packageNameHint: input.artifact.packageName,
          },
          signal,
        ),
      ),
  });
}

function deploymentFact(session: WebDriverProviderSession | undefined): RuntimeOperationFact {
  if (!session) {
    return Object.freeze({
      available: false,
      reason: 'owner-capability-missing',
      hint: 'The WebDriver provider session is no longer active for this device.',
    } as const);
  }
  if (!capabilitySupported(session.capabilities, 'install')) {
    return Object.freeze({
      available: false,
      reason: 'owner-capability-missing',
      hint: unsupportedCapabilityMessage(session.capabilities, 'install'),
    } as const);
  }
  return Object.freeze({ available: true } as const);
}

async function uploadAppIfNeeded(
  options: Readonly<{
    provider: string;
    uploadApp?: CloudWebDriverUploadApp;
  }>,
  session: WebDriverProviderSession,
  device: DeviceInfo,
  app: string,
  appPath: string,
  installOptions?: ProviderDeviceInstallOptions,
  signal?: AbortSignal,
) {
  if (!capabilitySupported(session.capabilities, 'install')) {
    throw new AppError(
      'UNSUPPORTED_OPERATION',
      unsupportedCapabilityMessage(session.capabilities, 'install'),
      { provider: options.provider, deviceId: device.id, platform: publicPlatformString(device) },
    );
  }
  const uploadApp = session.prepared.uploadApp ?? options.uploadApp;
  if (!uploadApp) return undefined;
  return await uploadApp({
    provider: options.provider,
    lease: session.lease,
    device,
    app,
    appPath,
    options: installOptions,
    signal,
  });
}

function deploymentResult(
  result: ProviderDeviceInstallResult | undefined,
  fallbackTarget?: string,
): AppDeploymentResult {
  if (!result) {
    throw new AppError(
      'UNSUPPORTED_OPERATION',
      'The WebDriver provider session no longer supports app deployment.',
    );
  }
  return {
    ...(result.bundleId ? { bundleId: result.bundleId } : {}),
    ...(result.packageName ? { packageName: result.packageName } : {}),
    ...(result.appName ? { appName: result.appName } : {}),
    ...((result.launchTarget ?? fallbackTarget)
      ? { launchTarget: result.launchTarget ?? fallbackTarget }
      : {}),
  };
}
