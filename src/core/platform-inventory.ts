import type { DeviceInfo, DeviceTarget, PlatformSelector } from '../kernel/device.ts';

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

// Exported so the web platform-plugin's `discoverDevices` reuses the SAME static
// device instance instead of carrying a divergent copy.
export const WEB_DESKTOP_DEVICE: DeviceInfo = {
  platform: 'web',
  id: 'agent-browser-chrome',
  name: 'Agent Browser Chrome',
  kind: 'device',
  target: 'desktop',
  booted: true,
};

export async function listLocalDeviceInventory(
  request: DeviceInventoryRequest,
): Promise<DeviceInfo[]> {
  if (request.platform === 'web') {
    return [WEB_DESKTOP_DEVICE];
  }

  if (shouldUseHostMacFastPath(request)) {
    const { listMacosDevices } = await import('../platforms/apple/os/macos/devices.ts');
    return await listMacosDevices();
  }

  if (request.platform === 'linux') {
    const { listLinuxDevices } = await import('../platforms/linux/devices.ts');
    return await listLinuxDevices();
  }

  if (request.platform === 'android') {
    const { listAndroidDevices } = await import('../platforms/android/devices.ts');
    return await listAndroidDevices({
      serialAllowlist: request.androidSerialAllowlist
        ? new Set(request.androidSerialAllowlist)
        : undefined,
    });
  }

  if (request.platform) {
    const { listAppleDevices } = await import('../platforms/apple/core/devices.ts');
    return await listAppleDevices({
      simulatorSetPath: request.iosSimulatorSetPath,
      udid: request.udid,
    });
  }

  const devices: DeviceInfo[] = [];
  // Linux local device is appended last so it does not displace
  // connected Android/Apple devices in implicit auto-selection.
  for (const platform of LOCAL_DEVICE_INVENTORY_PLATFORM_SELECTORS) {
    try {
      devices.push(...(await listLocalDeviceInventory({ ...request, platform })));
    } catch {}
  }
  return devices;
}

export function countDeviceInventoryByGroup(devices: DeviceInfo[]): DeviceInventoryGroupCounts {
  const counts = emptyDeviceInventoryGroupCounts();
  for (const device of devices) {
    const group = deviceInventoryGroupForDevice(device);
    counts[group].available += 1;
    if (device.booted === true) counts[group].booted += 1;
  }
  return counts;
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
  if (device.platform === 'ios' || device.platform === 'macos') return 'apple';
  return device.platform;
}

// Exported so the Apple platform-plugin's `discoverDevices` reuses the SAME
// host-mac fast-path predicate instead of carrying a divergent copy.
export function shouldUseHostMacFastPath(selector: {
  platform?: PlatformSelector;
  target?: DeviceTarget;
}): boolean {
  return (
    selector.platform === 'macos' ||
    (selector.platform === 'apple' && selector.target === 'desktop')
  );
}
