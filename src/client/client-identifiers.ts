import type { AgentDeviceIdentifiers } from '@agent-device/contracts/client';
import { isSerialAddressablePlatform, type PublicPlatform } from '@agent-device/kernel/device';

export function buildAppIdentifiers(params: {
  session?: string;
  bundleId?: string;
  packageName?: string;
  appId?: string;
}): AgentDeviceIdentifiers {
  const appId = params.appId ?? params.bundleId ?? params.packageName;
  return {
    session: params.session,
    appId,
    appBundleId: params.bundleId,
    package: params.packageName,
  };
}

export function buildDeviceIdentifiers(
  platform: PublicPlatform,
  id: string,
  name: string,
): AgentDeviceIdentifiers {
  return {
    deviceId: id,
    deviceName: name,
    ...(isSerialAddressablePlatform(platform)
      ? { serial: id }
      : platform === 'ios'
        ? { udid: id }
        : {}),
  };
}
