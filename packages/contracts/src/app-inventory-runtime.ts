import type { DeviceInfo } from '@agent-device/kernel/device';
import type { AppsFilter } from './app-inventory.ts';

export type InstalledAppInfo = Readonly<{
  id: string;
  name: string;
}>;

export type ListAppsInput = Readonly<{
  device: DeviceInfo;
  filter: AppsFilter;
}>;

export type AppInventoryRuntimeOperations = Readonly<{
  listApps(input: ListAppsInput): Promise<readonly InstalledAppInfo[]>;
}>;
