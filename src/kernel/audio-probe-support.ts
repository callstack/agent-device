import type { DeviceInfo } from './device.ts';

export function isHostSystemAudioProbeDevice(device: DeviceInfo): boolean {
  return (
    process.platform === 'darwin' &&
    (device.platform === 'macos' ||
      (device.platform === 'ios' && device.kind === 'simulator') ||
      (device.platform === 'android' && device.kind === 'emulator'))
  );
}

export function isAudioProbeSupportedDevice(device: DeviceInfo): boolean {
  return device.platform === 'web' || isHostSystemAudioProbeDevice(device);
}
