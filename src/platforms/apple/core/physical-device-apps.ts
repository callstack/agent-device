import type { AppsFilter } from '../../../contracts/app-inventory.ts';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { IOS_DEVICE_INSTALL_TIMEOUT_MS } from './config.ts';
import {
  listIosDeviceApps,
  resolveIosDeviceAppProcesses,
  runIosDevicectl,
  terminateIosDeviceApp,
} from './devicectl.ts';
import type { IosAppInfo, IosDeviceAppProcesses } from './app-info.ts';
import { isMissingAppErrorOutput } from './apps-simctl.ts';

export async function listCoreDeviceApps(
  device: DeviceInfo,
  filter: AppsFilter,
): Promise<IosAppInfo[]> {
  return await listIosDeviceApps(device, filter);
}

export async function installCoreDeviceApp(
  device: DeviceInfo,
  installablePath: string,
): Promise<void> {
  await runIosDevicectl(
    ['device', 'install', 'app', '--device', device.id, installablePath],
    {
      action: 'install iOS app',
      deviceId: device.id,
    },
    {
      timeoutMs: IOS_DEVICE_INSTALL_TIMEOUT_MS,
    },
  );
}

export async function uninstallCoreDeviceApp(device: DeviceInfo, bundleId: string): Promise<void> {
  await runIosDevicectl(
    ['device', 'uninstall', 'app', '--device', device.id, bundleId],
    { action: `uninstall iOS app ${bundleId}`, deviceId: device.id },
    {
      tolerateOutput: (stdout, stderr) =>
        isMissingAppErrorOutput(`${stdout}\n${stderr}`.toLowerCase()),
    },
  );
}

export async function terminateCoreDeviceApp(device: DeviceInfo, bundleId: string): Promise<void> {
  await terminateIosDeviceApp(device, bundleId);
}

export async function resolveCoreDeviceAppProcesses(
  device: DeviceInfo,
  bundleId: string,
): Promise<IosDeviceAppProcesses> {
  return await resolveIosDeviceAppProcesses(device, bundleId);
}
