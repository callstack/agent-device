import type {
  PlatformRuntimeHost,
  PlatformRuntimeOperations,
} from '@agent-device/contracts/platform-runtime-operations';
import { unavailableFact } from '@agent-device/contracts/platform-runtime';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import {
  awaitLimrunDeploymentOperation,
  type LimrunRequestOperationDrain,
} from './request-cancellation.ts';
import { isSupportedLimrunRuntimeDevice } from './runtime-device.ts';

const available = Object.freeze({ available: true } as const);
const deploymentUnavailable = unavailableFact(
  'owner-capability-missing',
  'The Limrun provider session is no longer active for this device.',
);
const pushUnavailable = unavailableFact(
  'unsupported-provider-mode',
  'Push notifications are unavailable for Limrun provider-owned devices.',
);
export type LimrunAppDeploymentRuntimeOptions = Readonly<{
  host: PlatformRuntimeHost;
  ownsDevice(device: DeviceInfo): boolean;
  isSessionActive?(device: DeviceInfo): boolean;
  bindDeployment?(
    device: DeviceInfo,
    signal: AbortSignal,
    operationDrain?: LimrunRequestOperationDrain,
  ): Promise<Partial<PlatformRuntimeOperations>>;
}>;

export function limrunAppDeploymentFacts(
  options: LimrunAppDeploymentRuntimeOptions,
  device: DeviceInfo,
) {
  const sessionActive = options.isSessionActive?.(device) ?? options.ownsDevice(device);
  const deployment =
    isSupportedLimrunRuntimeDevice(device) && sessionActive && options.bindDeployment
      ? available
      : deploymentUnavailable;
  return Object.freeze({
    deployApp: deployment,
    materializeAppSource: deployment,
    deployMaterializedApp: deployment,
    uninstallApp: deployment,
    sendPushNotification:
      device.platform === 'apple'
        ? deployment
        : sessionActive
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
  if (!limrunAppDeploymentFacts(options, device).deployApp.available) return {};
  const bind = options.bindDeployment!;
  const load = async () => {
    signal.throwIfAborted();
    const {
      deployApp,
      materializeAppSource,
      deployMaterializedApp,
      uninstallApp,
      sendPushNotification,
    } = await bind(device, signal, operationDrain);
    if (!deployApp || !materializeAppSource || !deployMaterializedApp || !uninstallApp) {
      throw new AppError(
        'UNSUPPORTED_OPERATION',
        'The Limrun provider session is no longer active.',
      );
    }
    return {
      deployApp,
      materializeAppSource,
      deployMaterializedApp,
      uninstallApp,
      sendPushNotification,
    };
  };
  return {
    ...(device.platform === 'apple'
      ? {
          sendPushNotification: async (
            input: import('@agent-device/contracts/app-deployment-runtime').PushNotificationInput,
          ) => {
            const operation = (await load()).sendPushNotification;
            if (!operation)
              throw new AppError('UNSUPPORTED_OPERATION', 'Apple push operation is unavailable');
            return await operation(input);
          },
        }
      : {}),
    deployApp: async (input) =>
      awaitLimrunDeploymentOperation(operationDrain, (await load()).deployApp(input), signal),
    materializeAppSource: async (input) => (await load()).materializeAppSource(input),
    deployMaterializedApp: async (input) => (await load()).deployMaterializedApp(input),
    uninstallApp: async (input) => (await load()).uninstallApp(input),
  };
}
