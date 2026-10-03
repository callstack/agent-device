import path from 'node:path';
import { readInfoPlistString } from './plist.ts';

export async function readIosBundleInfo(
  appBundlePath: string,
  signal?: AbortSignal,
): Promise<{ bundleId?: string; appName?: string }> {
  const infoPlistPath = path.join(appBundlePath, 'Info.plist');
  const [bundleId, displayName, bundleName] = await Promise.all([
    readInfoPlistString(infoPlistPath, 'CFBundleIdentifier', signal),
    readInfoPlistString(infoPlistPath, 'CFBundleDisplayName', signal),
    readInfoPlistString(infoPlistPath, 'CFBundleName', signal),
  ]);
  return {
    bundleId,
    appName: displayName ?? bundleName,
  };
}
