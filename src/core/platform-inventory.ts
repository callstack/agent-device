import type { DeviceInfo, DeviceTarget, PlatformSelector } from '../kernel/device.ts';

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

const WEB_DESKTOP_DEVICE: DeviceInfo = {
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
    const { listMacosDevices } = await import('../platforms/macos/devices.ts');
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
    const { listAppleDevices } = await import('../platforms/ios/devices.ts');
    return await listAppleDevices({
      simulatorSetPath: request.iosSimulatorSetPath,
      udid: request.udid,
    });
  }

  const devices: DeviceInfo[] = [];
  try {
    const { listAndroidDevices } = await import('../platforms/android/devices.ts');
    devices.push(
      ...(await listAndroidDevices({
        serialAllowlist: request.androidSerialAllowlist
          ? new Set(request.androidSerialAllowlist)
          : undefined,
      })),
    );
  } catch {}
  try {
    const { listAppleDevices } = await import('../platforms/ios/devices.ts');
    devices.push(
      ...(await listAppleDevices({
        simulatorSetPath: request.iosSimulatorSetPath,
        udid: request.udid,
      })),
    );
  } catch {}
  // Linux local device is appended last so it does not displace
  // connected Android/Apple devices in implicit auto-selection.
  try {
    const { listLinuxDevices } = await import('../platforms/linux/devices.ts');
    devices.push(...(await listLinuxDevices()));
  } catch {}
  return devices;
}

function shouldUseHostMacFastPath(selector: {
  platform?: PlatformSelector;
  target?: DeviceTarget;
}): boolean {
  return (
    selector.platform === 'macos' ||
    (selector.platform === 'apple' && selector.target === 'desktop')
  );
}
