import { type DeviceInfo } from '@agent-device/kernel/device';
import {
  LOCAL_DEVICE_INVENTORY_PLATFORM_SELECTORS,
  shouldUseHostMacFastPath,
  WEB_DESKTOP_DEVICE,
  type DeviceInventoryRequest,
} from '@agent-device/contracts/device';

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

  if (request.platform === 'vega') {
    const { listVegaDevices } = await import('../platforms/vega/devices.ts');
    return await listVegaDevices();
  }

  if (request.platform) {
    const { listAppleDevices } = await import('../platforms/apple/core/devices.ts');
    return await listAppleDevices({
      simulatorSetPath: request.iosSimulatorSetPath,
      udid: request.udid,
    });
  }

  // Probed concurrently: each platform shells out to its own toolchain, and
  // awaiting them in turn made an unfiltered lookup cost their sum — measured
  // at 6.7s on a host with the Apple, Android and Vega toolchains installed,
  // most of it spent enumerating platforms the request could not target.
  //
  // Results are still concatenated in selector order, so the Linux local device
  // stays last and does not displace connected Android/Apple devices in
  // implicit auto-selection.
  const perPlatform = await Promise.all(
    LOCAL_DEVICE_INVENTORY_PLATFORM_SELECTORS.map(async (platform) => {
      try {
        const listed = await listLocalDeviceInventory({ ...request, platform });
        // A platform that answers with anything but a list contributes nothing,
        // exactly as before: spreading a non-array used to throw into the catch.
        return Array.isArray(listed) ? listed : [];
      } catch {
        return [];
      }
    }),
  );
  return perPlatform.flat();
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
