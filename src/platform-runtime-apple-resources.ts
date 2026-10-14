import type { AppleSessionObservation } from '@agent-device/contracts/apple-session-observation';

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
