import type { SnapshotResult } from '@agent-device/contracts/interactor-types';
import type {
  ProviderDeviceInstallOptions,
  ProviderDeviceInstallResult,
} from '@agent-device/contracts/device';
import type { CloudWebDriverPlatform, CloudWebDriverUploadResult } from './runtime.ts';

export function providerInstallResult(
  upload: CloudWebDriverUploadResult | undefined,
  options: ProviderDeviceInstallOptions | undefined,
): ProviderDeviceInstallResult {
  const bundleId = upload?.bundleId ?? options?.appIdentifierHint;
  const packageName = upload?.packageName ?? options?.packageNameHint;
  return {
    bundleId,
    packageName,
    appName: upload?.appName,
    launchTarget: firstDefined(upload?.launchTarget, bundleId, packageName),
  };
}

export function snapshotBackendForPlatform(
  platform: CloudWebDriverPlatform,
): Extract<SnapshotResult['backend'], 'android' | 'xctest'> {
  return platform === 'ios' ? 'xctest' : 'android';
}

function firstDefined<T>(...values: Array<T | undefined>): T | undefined {
  return values.find((value) => value !== undefined);
}
