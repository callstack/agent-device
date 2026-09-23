import type { AppsFilter } from '@agent-device/contracts/device';
import type { DeviceInfo } from '@agent-device/kernel/device';
import {
  listIosDeviceApps,
  resolveIosDeviceAppProcesses,
  terminateIosDeviceApp,
} from './devicectl.ts';
import type { IosAppInfo, IosDeviceAppProcesses } from './app-info.ts';

export async function listCoreDeviceApps(
  device: DeviceInfo,
  filter: AppsFilter,
): Promise<IosAppInfo[]> {
  return await listIosDeviceApps(device, filter);
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

function isMissingAppErrorOutput(output: string): boolean {
  return (
    output.includes('not installed') ||
    output.includes('not found') ||
    output.includes('no such file')
  );
}
