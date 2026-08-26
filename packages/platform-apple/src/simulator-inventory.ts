import type { DeviceInventoryRequest } from '@agent-device/contracts/device';
import type {
  DeviceInventoryHostFor,
  PlatformRequestScope,
} from '@agent-device/contracts/platform-runtime-host';
import { sortAppleDevicesForSelection, type DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
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

type SimctlListDevicesPayload = {
  devices: Record<string, SimctlDeviceRecord[]>;
};

const BOOTED_SIMULATOR_PROBE_TIMEOUT_MS = 3_000;

export function buildSimctlListArgs(simulatorSetPath: string | undefined): string[] {
  const path = simulatorSetPath?.trim();
  return path ? ['--set', path, 'list', 'devices', '-j'] : ['list', 'devices', '-j'];
}

export function parseSimctlAppleDevices(
  payload: SimctlListDevicesPayload,
  simulatorSetPath: string | undefined,
): DeviceInfo[] {
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
        appleOs: resolveAppleOs(target, [device.deviceTypeIdentifier ?? '', device.name]),
        booted: device.state === 'Booted',
        ...(simulatorSetPath ? { simulatorSetPath } : {}),
      });
    }
  }
  return devices;
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
      args: buildSimctlListArgs(simulatorSetPath),
      ...(request.booted === true ? { timeoutMs: BOOTED_SIMULATOR_PROBE_TIMEOUT_MS } : {}),
    },
    scope.signal,
  );
  let devices: DeviceInfo[];
  try {
    const parsed = JSON.parse(result.stdout) as SimctlListDevicesPayload;
    devices = parseSimctlAppleDevices(parsed, simulatorSetPath);
  } catch (error) {
    throw new AppError('COMMAND_FAILED', 'Failed to parse simctl devices JSON', undefined, error);
  }
  for (const device of devices) {
    if (device.booted === true) await host.observations.deviceBooted(device);
  }
  return sortAppleDevicesForSelection(devices);
}
