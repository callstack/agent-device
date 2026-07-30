import { isIosFamily, isMacOs } from '@agent-device/kernel/device';
import type { DeviceInfo } from '@agent-device/kernel/device';

export function isHostSystemAudioProbeDevice(device: DeviceInfo): boolean {
  return (
    process.platform === 'darwin' &&
    (isMacOs(device) ||
      (isIosFamily(device) && device.kind === 'simulator') ||
      (device.platform === 'android' && device.kind === 'emulator'))
  );
}

export function isAudioProbeSupportedDevice(device: DeviceInfo): boolean {
  return device.platform === 'web' || isHostSystemAudioProbeDevice(device);
}
