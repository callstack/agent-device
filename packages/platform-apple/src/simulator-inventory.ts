import type { DeviceInventoryRequest } from '@agent-device/contracts/device';
import type {
  DeviceInventoryHostFor,
  PlatformRequestScope,
} from '@agent-device/contracts/platform-runtime-host';
import { sortAppleDevicesForSelection, type DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import { simctlListInventoryArgs } from './core/simctl.ts';
import {
  isSupportedAppleRuntime,
  resolveAppleOs,
  resolveAppleTargetFromRuntime,
} from './inventory-classification.ts';

type SimctlDeviceRecord = {
  name: string;
  udid: string;
  state: string;
  isAvailable: boolean;
  deviceTypeIdentifier?: string;
};

type SimctlListPayload = {
  devices: Record<string, SimctlDeviceRecord[]>;
  devicetypes?: Array<{ identifier: string; name: string }>;
  runtimes?: Array<{ identifier: string; version: string }>;
};

const BOOTED_SIMULATOR_PROBE_TIMEOUT_MS = 3_000;

export function parseSimctlAppleDevices(
  payload: SimctlListPayload,
  simulatorSetPath: string | undefined,
): DeviceInfo[] {
  const describe = simulatorDescriber(payload);
  const devices: DeviceInfo[] = [];
  for (const [runtime, runtimes] of Object.entries(payload.devices)) {
    if (!isSupportedAppleRuntime(runtime)) continue;
    for (const device of runtimes) {
      if (!device.isAvailable) continue;
      const target = resolveAppleTargetFromRuntime(runtime);
      devices.push({
        platform: 'apple',
        id: device.udid,
        name: device.name,
        kind: 'simulator',
        target,
        appleOs: resolveAppleOs(target, [runtime, device.deviceTypeIdentifier ?? '', device.name]),
        ...describe(runtime, device),
        booted: device.state === 'Booted',
        ...(simulatorSetPath ? { simulatorSetPath } : {}),
      });
    }
  }
  return devices;
}

/** Resolves a simulator's model and OS version from the device types and runtimes in the listing. */
function simulatorDescriber(
  payload: SimctlListPayload,
): (runtime: string, device: SimctlDeviceRecord) => Pick<DeviceInfo, 'model' | 'osVersion'> {
  const models = new Map(payload.devicetypes?.map((type) => [type.identifier, type.name]));
  const osVersions = new Map(payload.runtimes?.map((entry) => [entry.identifier, entry.version]));
  return (runtime, device) => {
    const model = models.get(device.deviceTypeIdentifier ?? '');
    const osVersion = osVersions.get(runtime);
    return {
      ...(model ? { model } : {}),
      ...(osVersion ? { osVersion } : {}),
    };
  };
}

export async function listAppleSimulators(
  host: DeviceInventoryHostFor<'apple'>,
  request: Readonly<DeviceInventoryRequest>,
  scope: PlatformRequestScope,
): Promise<DeviceInfo[]> {
  const simulatorSetPath = request.iosSimulatorSetPath?.trim() || undefined;
  const result = await host.appleTools.run(
    {
      tool: 'simctl',
      args: simctlListInventoryArgs(simulatorSetPath),
      ...(request.booted === true ? { timeoutMs: BOOTED_SIMULATOR_PROBE_TIMEOUT_MS } : {}),
    },
    scope.signal,
  );
  let devices: DeviceInfo[];
  try {
    const parsed = JSON.parse(result.stdout) as SimctlListPayload;
    devices = parseSimctlAppleDevices(parsed, simulatorSetPath);
  } catch (error) {
    throw new AppError('COMMAND_FAILED', 'Failed to parse simctl devices JSON', undefined, error);
  }
  for (const device of devices) {
    if (device.booted === true) await host.observations.deviceBooted(device);
  }
  return sortAppleDevicesForSelection(devices);
}
