import { resolveAppsFilter, type AppsFilter } from '@agent-device/contracts/device';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { isUserInstalledIosApp, type DoublespeedIosSession } from './ios.ts';

export type DoublespeedInstalledApp = {
  id: string;
  name?: string;
  installType: string;
};

/** The semantic capabilities of one live session that the platform-runtime owner composes. */
export type DoublespeedDeviceSession = {
  readonly device: DeviceInfo;
  listApps(filter?: AppsFilter, signal?: AbortSignal): Promise<DoublespeedInstalledApp[]>;
  readLogs(appId: string, lineLimit: number, signal?: AbortSignal): Promise<string>;
  getForegroundApp(signal?: AbortSignal): Promise<{ appId?: string }>;
};

export function createDoublespeedDeviceSession(
  session: DoublespeedIosSession,
): DoublespeedDeviceSession {
  return {
    device: session.device,
    listApps: async (filter, signal) =>
      (await session.client.listApps(signal))
        .filter((app) => resolveAppsFilter(filter) === 'all' || isUserInstalledIosApp(app))
        .map((app) => ({
          id: app.bundleId,
          ...(app.name ? { name: app.name } : {}),
          installType: app.installType,
        }))
        .sort((left, right) => left.id.localeCompare(right.id)),
    readLogs: async (appId, lineLimit, signal) =>
      await session.client.appLogTail(appId, lineLimit, signal),
    getForegroundApp: async (signal) => {
      const foreground = await session.client.foregroundApp(signal);
      return foreground.bundleId ? { appId: foreground.bundleId } : {};
    },
  };
}
