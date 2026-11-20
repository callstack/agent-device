import type {
  DeviceBootObservation,
  DeviceBootObservationService,
  LaunchedDeviceProcessService,
  LaunchedProcessCheck,
  LaunchedProcessStopConfirmation,
} from '@agent-device/contracts/device-boot';
import type { AndroidEmulatorLaunchIdentity } from '@agent-device/contracts/device-readiness-runtime';
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

/**
 * Whether the process that launched a device is still the caller's own launch, and whether it took
 * the shutdown the caller asked of the device. Only an Android emulator has a host process this
 * machine launches to bring the device up, so every other leaf answers `not-applicable` rather than
 * a miss, and the caller stops the device on the platform's answer alone.
 */
export const launchedDeviceProcess: LaunchedDeviceProcessService = Object.freeze({
  async checkLaunchedProcess(
    device: DeviceInfo,
    identity: AndroidEmulatorLaunchIdentity | undefined,
  ): Promise<LaunchedProcessCheck> {
    if (!isAndroidEmulator(device)) return 'not-applicable';
    if (!identity) return 'unverified';
    const { checkAndroidEmulatorLaunchProcess } =
      await import('@agent-device/platform-android/device-boot');
    return await checkAndroidEmulatorLaunchProcess(identity);
  },
  async confirmLaunchedProcessStopped(
    device: DeviceInfo,
    identity: AndroidEmulatorLaunchIdentity,
  ): Promise<LaunchedProcessStopConfirmation> {
    if (!isAndroidEmulator(device)) return 'stopped';
    const { confirmAndroidEmulatorLaunchProcessStopped } =
      await import('@agent-device/platform-android/device-boot');
    return await confirmAndroidEmulatorLaunchProcessStopped(identity);
  },
});

/** The one device kind whose boot this host starts as a process it can later name. */
function isAndroidEmulator(device: DeviceInfo): boolean {
  return device.platform === 'android' && device.kind === 'emulator';
}
