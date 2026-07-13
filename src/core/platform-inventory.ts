import { type DeviceInfo } from '../kernel/device.ts';
import {
  LOCAL_DEVICE_INVENTORY_PLATFORM_SELECTORS,
  shouldUseHostMacFastPath,
  WEB_DESKTOP_DEVICE,
  type DeviceInventoryRequest,
} from '../contracts/device-inventory.ts';

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
      serialAllowlist: resolveAndroidDiscoverySerialAllowlist(request),
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

export function resolveAndroidDiscoverySerialAllowlist(
  request: DeviceInventoryRequest,
): ReadonlySet<string> | undefined {
  const policyAllowlist = request.androidSerialAllowlist;
  const selectedSerial = request.serial?.trim();
  if (!selectedSerial) return policyAllowlist ? new Set(policyAllowlist) : undefined;
  if (!policyAllowlist) return new Set([selectedSerial]);
  return new Set(policyAllowlist.includes(selectedSerial) ? [selectedSerial] : []);
}
