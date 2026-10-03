import type { IosAppInfo } from './app-info.ts';

export function filterAppleAppsByBundlePrefix(
  apps: IosAppInfo[],
  filter: 'user-installed' | 'all',
): IosAppInfo[] {
  if (filter === 'user-installed') {
    return apps.filter((app) => !app.bundleId.startsWith('com.apple.'));
  }
  return apps;
}
