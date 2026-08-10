import type { DeviceInventoryRequest } from '@agent-device/contracts/device';
import type {
  DeviceInventoryHostFor,
  DeviceInventorySource,
  PlatformRequestScope,
} from '@agent-device/contracts/platform';
import { sortAppleDevicesForSelection, type DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import { listPhysicalAppleDevices } from './physical-inventory.ts';
import { listAppleSimulators } from './simulator-inventory.ts';

export function createAppleInventorySource(
  host: DeviceInventoryHostFor<'apple'>,
): DeviceInventorySource {
  return Object.freeze({
    discover: async (request, scope) => await discoverAppleDevices(host, request, scope),
  });
}

async function discoverAppleDevices(
  host: DeviceInventoryHostFor<'apple'>,
  request: Readonly<DeviceInventoryRequest>,
  scope: PlatformRequestScope,
): Promise<DeviceInfo[]> {
  if (isMacOnlyRequest(request)) {
    return [hostMacDevice(host)];
  }
  if (host.hostOs !== 'darwin') {
    throw new AppError('UNSUPPORTED_PLATFORM', 'Apple tools are only available on macOS');
  }
  if (!(await host.appleTools.isXcrunAvailable(scope.signal))) {
    throw new AppError('TOOL_MISSING', 'xcrun not found in PATH');
  }

  const simulators = await listAppleSimulators(host, request, scope);
  if (request.kind === 'simulator') return simulators;

  const withHost = [...simulators, hostMacDevice(host)];
  if (
    request.iosSimulatorSetPath ||
    (request.udid && simulators.some((device) => device.id === request.udid))
  ) {
    return sortAppleDevicesForSelection(withHost);
  }

  const physical = await listPhysicalAppleDevices(host, scope);
  return sortAppleDevicesForSelection(mergeAppleDevices(withHost, physical));
}

function isMacOnlyRequest(request: Readonly<DeviceInventoryRequest>): boolean {
  return (
    request.platform === 'macos' || (request.platform === 'apple' && request.target === 'desktop')
  );
}

function hostMacDevice(host: DeviceInventoryHostFor<'apple'>): DeviceInfo {
  return {
    platform: 'apple',
    id: 'host-macos-local',
    name: host.hostName,
    kind: 'device',
    target: 'desktop',
    appleOs: 'macos',
    booted: true,
  };
}

function mergeAppleDevices(primary: DeviceInfo[], supplemental: DeviceInfo[]): DeviceInfo[] {
  const ids = new Set(primary.map((device) => device.id));
  return [
    ...primary,
    ...supplemental.filter((device) => {
      if (ids.has(device.id)) return false;
      ids.add(device.id);
      return true;
    }),
  ];
}
