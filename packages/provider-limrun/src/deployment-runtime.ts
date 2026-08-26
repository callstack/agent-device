import type {
  AppDeploymentInput,
  AppDeploymentResult,
  DeployMaterializedAppInput,
  MaterializeAppSourceInput,
  MaterializedAppSource,
} from '@agent-device/contracts/app-deployment-runtime';
import type {
  PlatformRuntimeHost,
  PlatformRuntimeOperations,
} from '@agent-device/contracts/platform-runtime-operations';
import type { RuntimeOperationFact } from '@agent-device/contracts/platform-runtime';
import type { ProviderDeviceInstallResult } from '@agent-device/contracts/device';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import type { LimrunRequestOperationDrain } from './request-cancellation.ts';
import { isSupportedLimrunRuntimeDevice } from './runtime-device.ts';

const available = Object.freeze({ available: true } as const);
const deploymentUnavailable = Object.freeze({
  available: false,
  reason: 'owner-capability-missing',
  hint: 'The Limrun provider session is no longer active for this device.',
} as const);
const pushUnavailable = Object.freeze({
  available: false,
  reason: 'unsupported-provider-mode',
  hint: 'Push notifications are unavailable for Limrun provider-owned devices.',
} as const);

export type LimrunAppDeploymentRuntimeOptions = Readonly<{
  host: PlatformRuntimeHost;
  ownsDevice(device: DeviceInfo): boolean;
  /** A currently live provider session, distinct from the provider-owned device namespace. */
  isSessionActive?(device: DeviceInfo): boolean;
  deployApp?(
    device: DeviceInfo,
    input: AppDeploymentInput,
    signal: AbortSignal,
    operationDrain?: LimrunRequestOperationDrain,
  ): Promise<ProviderDeviceInstallResult | undefined>;
  deployMaterializedApp?(
    device: DeviceInfo,
    input: DeployMaterializedAppInput,
    signal: AbortSignal,
    operationDrain?: LimrunRequestOperationDrain,
  ): Promise<ProviderDeviceInstallResult | undefined>;
}>;

export function limrunAppDeploymentFacts(
  options: LimrunAppDeploymentRuntimeOptions,
  device: DeviceInfo,
): Readonly<{
  deployApp: RuntimeOperationFact;
  materializeAppSource: RuntimeOperationFact;
  deployMaterializedApp: RuntimeOperationFact;
  sendPushNotification: RuntimeOperationFact;
}> {
  const deployment = limrunDeploymentFact(options, device);
  return Object.freeze({
    deployApp: deployment,
    materializeAppSource: deployment,
    deployMaterializedApp: deployment,
    sendPushNotification: isActiveLimrunRuntimeSession(options, device)
      ? pushUnavailable
      : deploymentUnavailable,
  });
}

export function createLimrunAppDeploymentOperations(
  options: LimrunAppDeploymentRuntimeOptions,
  device: DeviceInfo,
  signal: AbortSignal,
  operationDrain?: LimrunRequestOperationDrain,
): Partial<PlatformRuntimeOperations> {
  const deployApp = options.deployApp;
  const deployMaterializedApp = options.deployMaterializedApp;
  if (
    !limrunAppDeploymentFacts(options, device).deployApp.available ||
    !deployApp ||
    !deployMaterializedApp
  ) {
    return Object.freeze({});
  }
  return Object.freeze({
    deployApp: async (input: AppDeploymentInput) =>
      limrunDeploymentResult(await deployApp(device, input, signal, operationDrain)),
    materializeAppSource: async (input: MaterializeAppSourceInput) =>
      await materializeLimrunSource(options.host, device, input, signal),
    deployMaterializedApp: async (input: DeployMaterializedAppInput) =>
      limrunDeploymentResult(await deployMaterializedApp(device, input, signal, operationDrain)),
  });
}

function limrunDeploymentFact(
  options: LimrunAppDeploymentRuntimeOptions,
  device: DeviceInfo,
): RuntimeOperationFact {
  return isSupportedLimrunRuntimeDevice(device) &&
    isActiveLimrunRuntimeSession(options, device) &&
    options.deployApp &&
    options.deployMaterializedApp
    ? available
    : deploymentUnavailable;
}

/** Admission liveness is synchronous metadata from the provider runtime, never a bind-time probe. */
function isActiveLimrunRuntimeSession(
  options: Pick<LimrunAppDeploymentRuntimeOptions, 'ownsDevice' | 'isSessionActive'>,
  device: DeviceInfo,
): boolean {
  return options.isSessionActive?.(device) ?? options.ownsDevice(device);
}

async function materializeLimrunSource(
  host: PlatformRuntimeHost,
  device: DeviceInfo,
  input: MaterializeAppSourceInput,
  signal: AbortSignal,
): Promise<MaterializedAppSource> {
  const deploymentHost =
    device.platform === 'apple' ? host.appleDeployment : host.androidDeployment;
  return await deploymentHost.prepareArtifact(input, { signal });
}

function limrunDeploymentResult(
  result: ProviderDeviceInstallResult | undefined,
): AppDeploymentResult {
  if (!result) {
    throw new AppError('UNSUPPORTED_OPERATION', 'The Limrun provider session is no longer active.');
  }
  return result;
}
