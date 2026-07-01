import { isIosFamily, type DeviceInfo } from '../kernel/device.ts';

export function isIosSimulator(device: DeviceInfo): boolean {
  return isIosFamily(device) && device.kind === 'simulator';
}

export function isAndroidEmulator(device: DeviceInfo): boolean {
  return device.platform === 'android' && device.kind === 'emulator';
}
