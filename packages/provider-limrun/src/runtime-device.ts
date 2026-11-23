import type { DeviceInfo } from '@agent-device/kernel/device';
import { parseLimrunDeviceId } from './device.ts';

/** The exact mobile device identities that a direct Limrun runtime can own. */
export function isSupportedLimrunRuntimeDevice(device: DeviceInfo): boolean {
  const parsed = parseLimrunDeviceId(device.id);
  if (!parsed || device.target !== 'mobile') return false;
  return parsed.platform === 'ios'
    ? device.platform === 'apple' &&
        (device.appleOs === 'ios' || device.appleOs === 'ipados' || device.appleOs === 'watchos') &&
        device.kind === 'simulator' &&
        device.iosPhysicalDeviceBackend === undefined
    : device.platform === 'android' &&
        device.appleOs === undefined &&
        device.kind === 'emulator' &&
        device.iosPhysicalDeviceBackend === undefined;
}
