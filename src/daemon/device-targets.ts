import type { DeviceInfo } from '../kernel/device.ts';

export function isIosSimulator(device: DeviceInfo): boolean {
  return device.platform === 'ios' && device.kind === 'simulator';
}

export function isAndroidEmulator(device: DeviceInfo): boolean {
  return device.platform === 'android' && device.kind === 'emulator';
}
