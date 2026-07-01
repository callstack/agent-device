import { isIosFamily, isMacOs } from './device.ts';
import type { DeviceInfo } from './device.ts';

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
