import type {
  DeviceBootObservation,
  DeviceBootObservationService,
  DeviceShutdownGenerationService,
} from '@agent-device/contracts/device-boot';
import { isIosFamily, type DeviceInfo } from '@agent-device/kernel/device';

/**
 * The single answer to "when did this device's current boot begin?", assembled from whichever
 * family owns the device. Families that answer no boot question for a leaf report
 * `unsupported-device`, so a caller never branches on platform to decide what an answer means.
 */
export const deviceBootObservation: DeviceBootObservationService & DeviceShutdownGenerationService =
  Object.freeze({
    async assessShutdownGeneration(device, expected) {
      if (device.platform !== 'android' || device.kind !== 'emulator') return 'not-applicable';
      if (!expected) return 'unobserved';
      const { ANDROID_EMULATOR_GENERATION_BUDGET_MS, observeAndroidEmulatorGeneration } =
        await import('@agent-device/platform-android/device-boot');
      const { Deadline } = await import('@agent-device/host-kit/retry');
      const deadline = Deadline.fromTimeoutMs(ANDROID_EMULATOR_GENERATION_BUDGET_MS);
      const first = await observeAndroidEmulatorGeneration(device, { deadline });
      if (!first) return 'unobserved';
      const second = await observeAndroidEmulatorGeneration(device, { deadline });
      if (!second || second.pid !== first.pid || second.startTime !== first.startTime)
        return 'unobserved';
      return first.pid === expected.pid && first.startTime === expected.startTime
        ? 'same'
        : 'changed';
    },
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
