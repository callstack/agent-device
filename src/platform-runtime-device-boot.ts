import type {
  DeviceBootObservation,
  DeviceBootObservationService,
  DeviceShutdownGenerationService,
} from '@agent-device/contracts/device-boot';
import { isIosFamily, type DeviceInfo } from '@agent-device/kernel/device';
import { emitDiagnostic } from '@agent-device/host-kit/diagnostics';

/**
 * The single answer to "when did this device's current boot begin?", assembled from whichever
 * family owns the device. Families that answer no boot question for a leaf report
 * `unsupported-device`, so a caller never branches on platform to decide what an answer means.
 */
export const deviceBootObservation: DeviceBootObservationService & DeviceShutdownGenerationService =
  Object.freeze({
    async assessShutdownGeneration(device, expected) {
      if (device.platform !== 'android' || device.kind !== 'emulator') return 'not-applicable';
      const unobserved = (cause: string) => {
        emitDiagnostic({
          level: 'warn',
          phase: 'android_launch_identity_unobserved',
          data: { step: 'assess', cause, serial: device.id },
        });
        return 'unobserved' as const;
      };
      if (!expected) return unobserved('unbound-at-open');
      const { ANDROID_EMULATOR_GENERATION_BUDGET_MS, inspectAndroidEmulatorGeneration } =
        await import('@agent-device/platform-android/device-boot');
      const { Deadline } = await import('@agent-device/host-kit/retry');
      const deadline = Deadline.fromTimeoutMs(ANDROID_EMULATOR_GENERATION_BUDGET_MS);
      const first = await inspectAndroidEmulatorGeneration(device, { deadline });
      if (!('identity' in first)) return unobserved(`first-${first.miss}`);
      const second = await inspectAndroidEmulatorGeneration(device, { deadline });
      if (!('identity' in second)) return unobserved(`second-${second.miss}`);
      if (
        second.identity.pid !== first.identity.pid ||
        second.identity.startTime !== first.identity.startTime
      ) {
        return unobserved('reads-disagree');
      }
      return first.identity.pid === expected.pid && first.identity.startTime === expected.startTime
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
