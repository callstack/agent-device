import type { AppInventoryRuntimeHost, InstalledAppInfo } from '@agent-device/contracts/platform';
import type { AppsFilter } from '@agent-device/contracts/device';
import type { DeviceInfo } from '@agent-device/kernel/device';

export function createAppInventoryRuntimeHost(): AppInventoryRuntimeHost {
  return Object.freeze({
    apple: Object.freeze({
      listApps: async (device: DeviceInfo, filter: AppsFilter) => {
        const { listIosApps } = await import('./platforms/apple/core/apps.ts');
        return mapAppleApps(await listIosApps(device, filter));
      },
    }),
    android: Object.freeze({
      listApps: async (device: DeviceInfo, filter: AppsFilter) => {
        const { listAndroidApps } = await import('./platforms/android/app-lifecycle.ts');
        return (await listAndroidApps(device, filter)).map((app) => ({
          id: app.package,
          name: app.name,
        }));
      },
    }),
    harmonyos: Object.freeze({
      listApps: async (device: DeviceInfo, filter: AppsFilter, signal: AbortSignal) => {
        const { listHarmonyApps } = await import('./platforms/harmonyos/app-lifecycle.ts');
        return (await listHarmonyApps(device, filter, { signal })).map((app) => ({
          id: app.package,
          name: app.name,
        }));
      },
    }),
  });
}

function mapAppleApps(
  apps: readonly { bundleId: string; name: string }[],
): readonly InstalledAppInfo[] {
  return apps.map((app) => ({ id: app.bundleId, name: app.name }));
}
