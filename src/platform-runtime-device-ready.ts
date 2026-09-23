import { isIosFamily, type DeviceInfo } from '@agent-device/kernel/device';
import { loadAndroidMechanics } from './platform-runtime-android-mechanics.ts';

/**
 * Runs concrete local-platform readiness mechanics from the root composition layer.
 * Returns false when the platform has no readiness preparation step.
 */
export async function ensureLocalPlatformDeviceReady(device: DeviceInfo): Promise<boolean> {
  if (isIosFamily(device)) {
    if (device.kind === 'simulator') {
      const { ensureBootedSimulator } = await import('@agent-device/platform-apple/simulator');
      await ensureBootedSimulator(device);
      return true;
    }
    if (device.kind === 'device') {
      const { resolveIosPhysicalDeviceControl } =
        await import('@agent-device/platform-apple/physical-device');
      const control = resolveIosPhysicalDeviceControl(device);
      await control.ensureReady(device);
      return true;
    }
  }
  if (device.platform === 'android') {
    const { waitForAndroidBoot } = await loadAndroidMechanics();
    await waitForAndroidBoot(device.id);
    return true;
  }
  return false;
}
