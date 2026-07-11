import {
  isIosFamily,
  isMacOs,
  type DeviceInfo,
  type DeviceTarget,
  type PlatformSelector,
} from '../kernel/device.ts';

export const LOCAL_DEVICE_INVENTORY_PLATFORM_SELECTORS = ['android', 'apple', 'linux'] as const;

export type DeviceInventoryRequest = {
  platform?: PlatformSelector;
  target?: DeviceTarget;
  deviceName?: string;
  udid?: string;
  serial?: string;
  leaseId?: string;
  leaseProvider?: string;
  deviceKey?: string;
  clientId?: string;
  iosSimulatorSetPath?: string;
  androidSerialAllowlist?: string[];
};

export type DeviceInventoryGroup = 'android' | 'apple' | 'linux' | 'web';
export type DeviceInventoryGroupCounts = Record<
  DeviceInventoryGroup,
  { available: number; booted: number }
>;

export const WEB_DESKTOP_DEVICE: DeviceInfo = {
  platform: 'web',
  id: 'agent-browser-chrome',
  name: 'Agent Browser Chrome',
  kind: 'device',
  target: 'desktop',
  booted: true,
};

export function countDeviceInventoryByGroup(devices: DeviceInfo[]): DeviceInventoryGroupCounts {
  const counts = emptyDeviceInventoryGroupCounts();
  for (const device of devices) {
    const group = deviceInventoryGroupForDevice(device);
    counts[group].available += 1;
    if (device.booted === true) counts[group].booted += 1;
  }
  return counts;
}

export function shouldUseHostMacFastPath(selector: {
  platform?: PlatformSelector;
  target?: DeviceTarget;
}): boolean {
  return (
    selector.platform === 'macos' ||
    (selector.platform === 'apple' && selector.target === 'desktop')
  );
}

function emptyDeviceInventoryGroupCounts(): DeviceInventoryGroupCounts {
  return {
    android: { available: 0, booted: 0 },
    apple: { available: 0, booted: 0 },
    linux: { available: 0, booted: 0 },
    web: { available: 0, booted: 0 },
  };
}

function deviceInventoryGroupForDevice(device: DeviceInfo): DeviceInventoryGroup {
  if (isIosFamily(device) || isMacOs(device)) return 'apple';
  return device.platform;
}
