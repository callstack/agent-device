import type { AppleRunnerRequestOptions } from '@agent-device/contracts/apple-runner-request';
import type { AppleSessionObservation } from '@agent-device/contracts/apple-session-observation';
import type { ElementSelectorKey } from '@agent-device/contracts/interactor-types';
import type { DeviceInfo } from '@agent-device/kernel/device';

let observation: AppleSessionObservation | undefined;

async function loadAppleSessionObservation(): Promise<AppleSessionObservation> {
  if (observation) return observation;
  const { createAppleSessionObservation } =
    await import('@agent-device/platform-apple/session-observation');
  const { listLocalDeviceInventory, shouldPropagateDeviceInventoryProbeError } =
    await import('@agent-device/device-selection/device-inventory-context');
  observation ??= createAppleSessionObservation({
    listLocalDevices: listLocalDeviceInventory,
    shouldPropagateProbeError: shouldPropagateDeviceInventoryProbeError,
  });
  return observation;
}

export const appleSessionObservation: AppleSessionObservation = Object.freeze({
  async observeRunnerSession(deviceId) {
    return (await loadAppleSessionObservation()).observeRunnerSession(deviceId);
  },
  async resolveSoleForegroundApp(options) {
    return (await loadAppleSessionObservation()).resolveSoleForegroundApp(options);
  },
});

export async function queryAppleRuntimeSelector(
  device: DeviceInfo,
  selector: Readonly<{ key: ElementSelectorKey; value: string }>,
  appBundleId: string | undefined,
  options: AppleRunnerRequestOptions,
): Promise<Record<string, unknown>> {
  const { queryAppleRunnerSelector } =
    await import('@agent-device/platform-apple/runner/operations');
  return await queryAppleRunnerSelector(device, selector, appBundleId, options);
}
