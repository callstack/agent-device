import type { AppsFilter } from '@agent-device/contracts/device';
import {
  appsRuntimeUse,
  type BoundDeviceRuntime,
  type EnsureReadyInput,
  type InstalledAppInfo,
} from '@agent-device/contracts/platform';
import type { DeviceInfo } from '@agent-device/kernel/device';

export function ensureAppsRuntimeReady(
  runtime: BoundDeviceRuntime<typeof appsRuntimeUse>,
  input: EnsureReadyInput,
): Promise<DeviceInfo> {
  return runtime.operations.ensureReady(input);
}

export function listAppsFromRuntime(
  runtime: BoundDeviceRuntime<typeof appsRuntimeUse>,
  device: DeviceInfo,
  filter: AppsFilter,
): Promise<readonly InstalledAppInfo[]> {
  return runtime.operations.listApps({ device, filter });
}
