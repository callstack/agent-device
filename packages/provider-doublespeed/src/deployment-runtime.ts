import type {
  AppDeploymentInput,
  AppDeploymentResult,
  DeployMaterializedAppInput,
  MaterializeAppSourceInput,
} from '@agent-device/contracts/app-deployment-runtime';
import type {
  PlatformRuntimeHost,
  PlatformRuntimeOperations,
} from '@agent-device/contracts/platform-runtime-operations';
import type { RuntimeOperationFact } from '@agent-device/contracts/platform-runtime';
import type { ProviderDeviceInstallResult } from '@agent-device/contracts/device';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import { isSupportedDoublespeedDevice } from './device.ts';

const available = Object.freeze({ available: true } as const);
const deploymentUnavailable = Object.freeze({
  available: false,
  reason: 'owner-capability-missing',
  hint: 'The Doublespeed provider session is no longer active for this device.',
} as const);
const pushUnavailable = Object.freeze({
  available: false,
  reason: 'unsupported-provider-mode',
  hint: 'Push notifications are unavailable for Doublespeed provider-owned devices.',
} as const);

export type DoublespeedAppDeploymentRuntimeOptions = Readonly<{
  host: PlatformRuntimeHost;
  ownsDevice(device: DeviceInfo): boolean;
  /** A currently live provider session, distinct from the provider-owned device namespace. */
  isSessionActive?(device: DeviceInfo): boolean;
  deployApp?(
    device: DeviceInfo,
    input: AppDeploymentInput,
    signal: AbortSignal,
  ): Promise<ProviderDeviceInstallResult | undefined>;
  deployMaterializedApp?(
    device: DeviceInfo,
    input: DeployMaterializedAppInput,
    signal: AbortSignal,
  ): Promise<ProviderDeviceInstallResult | undefined>;
}>;

export function doublespeedAppDeploymentFacts(
  options: DoublespeedAppDeploymentRuntimeOptions,
  device: DeviceInfo,
): Readonly<{
  deployApp: RuntimeOperationFact;
  materializeAppSource: RuntimeOperationFact;
  deployMaterializedApp: RuntimeOperationFact;
  sendPushNotification: RuntimeOperationFact;
}> {
  const deployment = doublespeedDeploymentFact(options, device);
  return Object.freeze({
    deployApp: deployment,
    materializeAppSource: deployment,
    deployMaterializedApp: deployment,
    sendPushNotification: isActiveSession(options, device)
      ? pushUnavailable
      : deploymentUnavailable,
  });
}

export function createDoublespeedAppDeploymentOperations(
  options: DoublespeedAppDeploymentRuntimeOptions,
  device: DeviceInfo,
  signal: AbortSignal,
): Partial<PlatformRuntimeOperations> {
  const deployApp = options.deployApp;
  const deployMaterializedApp = options.deployMaterializedApp;
  if (
    !doublespeedAppDeploymentFacts(options, device).deployApp.available ||
    !deployApp ||
    !deployMaterializedApp
  ) {
    return Object.freeze({});
  }
  return Object.freeze({
    deployApp: async (input: AppDeploymentInput) =>
      deploymentResult(await deployApp(device, input, signal)),
    materializeAppSource: async (input: MaterializeAppSourceInput) =>
      await options.host.appleDeployment.prepareArtifact(input, { signal }),
    deployMaterializedApp: async (input: DeployMaterializedAppInput) =>
      deploymentResult(await deployMaterializedApp(device, input, signal)),
  });
}

function doublespeedDeploymentFact(
  options: DoublespeedAppDeploymentRuntimeOptions,
  device: DeviceInfo,
): RuntimeOperationFact {
  return isSupportedDoublespeedDevice(device) &&
    isActiveSession(options, device) &&
    options.deployApp &&
    options.deployMaterializedApp
    ? available
    : deploymentUnavailable;
}

/** Admission liveness is synchronous metadata from the provider runtime, never a bind-time probe. */
function isActiveSession(
  options: Pick<DoublespeedAppDeploymentRuntimeOptions, 'ownsDevice' | 'isSessionActive'>,
  device: DeviceInfo,
): boolean {
  return options.isSessionActive?.(device) ?? options.ownsDevice(device);
}

function deploymentResult(result: ProviderDeviceInstallResult | undefined): AppDeploymentResult {
  if (!result) {
    throw new AppError(
      'UNSUPPORTED_OPERATION',
      'The Doublespeed provider session is no longer active.',
    );
  }
  return result;
}
