import type { AppsFilter } from '@agent-device/contracts/device';
import type { InstalledAppInfo } from '@agent-device/contracts/app-inventory-runtime';
import type { EnsureReadyInput } from '@agent-device/contracts/device-readiness-runtime';
import type { BoundDeviceRuntime } from '@agent-device/contracts/platform-runtime';
import { appsRuntimeUse } from '@agent-device/contracts/platform-runtime-operations';
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
