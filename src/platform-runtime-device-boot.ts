import type {
  DeviceBootObservation,
  DeviceBootObservationService,
} from '@agent-device/contracts/device-boot';
import { isIosFamily, type DeviceInfo } from '@agent-device/kernel/device';

/**
 * The single answer to "when did this device's current boot begin?", assembled from whichever
 * family owns the device. Families that answer no boot question for a leaf report
 * `unsupported-device`, so a caller never branches on platform to decide what an answer means.
 */
export const deviceBootObservation: DeviceBootObservationService = Object.freeze({
  async observeBootTimeMs(device: DeviceInfo): Promise<DeviceBootObservation> {
    if (isIosFamily(device) && device.kind === 'simulator') {
      const { observeSimulatorBootTimeMs } =
        await import('@agent-device/platform-apple/simulator-boot');
      return await observeSimulatorBootTimeMs(device);
    }
    if (device.platform === 'android') {
      const { observeAndroidBootTimeMs } =
        await import('@agent-device/platform-android/device-boot');
      return await observeAndroidBootTimeMs(device);
    }
    return { observed: false, reason: 'unsupported-device' };
  },
});
