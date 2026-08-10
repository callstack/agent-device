import type {
  DeviceInventoryHostFor,
  PlatformRequestScope,
} from '@agent-device/contracts/platform';
import type { DeviceInfo } from '@agent-device/kernel/device';
import {
  mapDevicectlAppleDevice,
  resolveAppleOs,
  resolveAppleTargetFromLabel,
  type DevicectlAppleDevice,
} from './inventory-classification.ts';

const IOS_DEVICECTL_LIST_TIMEOUT_MS = 8_000;
const XCTRACE_SECTION_HEADER_PATTERN = /^==\s*(.+?)\s*==$/;
const XCTRACE_DEVICE_LINE_PATTERN =
  /^(?<name>.+?)\s+(?:\[(?<idBracket>[^[\]]+)\]|\((?<osVersion>[^)]+)\)\s+\((?<idParen>[^)]+)\))\s*$/;

type DevicectlListDevicesPayload = {
  result?: { devices?: DevicectlAppleDevice[] };
};

export function parseXctracePhysicalAppleDevices(output: string): DeviceInfo[] {
  const devices: DeviceInfo[] = [];
  let section: string | null = null;
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const sectionMatch = XCTRACE_SECTION_HEADER_PATTERN.exec(line);
    if (sectionMatch) {
      section = sectionMatch[1]?.trim() ?? null;
      continue;
    }
    if (section !== 'Devices') continue;
    const device = parseXctracePhysicalAppleDeviceLine(line);
    if (device) devices.push(device);
  }
  return devices;
}

function parseXctracePhysicalAppleDeviceLine(line: string): DeviceInfo | undefined {
  const groups = XCTRACE_DEVICE_LINE_PATTERN.exec(line)?.groups;
  if (!groups) return undefined;
  const name = groups.name?.trim();
  const id = groups.idBracket?.trim() || groups.idParen?.trim();
  if (!name || !id) return undefined;
  const target = resolveAppleTargetFromLabel(name);
  if (!target) return undefined;
  const osVersion = groups.osVersion?.trim();
  return {
    platform: 'apple',
    id,
    name,
    kind: 'device',
    target,
    appleOs: resolveAppleOs(target, osVersion ? [name, osVersion] : [name]),
    iosPhysicalDeviceBackend: 'xctest',
    booted: true,
  };
}

export async function listPhysicalAppleDevices(
  host: DeviceInventoryHostFor<'apple'>,
  scope: PlatformRequestScope,
): Promise<DeviceInfo[]> {
  const [devicectl, xctrace] = await Promise.all([
    listPhysicalDevicesFromDevicectl(host, scope),
    listPhysicalDevicesFromXctrace(host, scope),
  ]);
  return mergeAppleDevices(devicectl, xctrace);
}

async function listPhysicalDevicesFromDevicectl(
  host: DeviceInventoryHostFor<'apple'>,
  scope: PlatformRequestScope,
): Promise<DeviceInfo[]> {
  let temporaryFile;
  try {
    temporaryFile = await host.files.createTemporaryTextFile({
      prefix: 'agent-device-devicectl-',
      suffix: '.json',
    });
    const result = await host.appleTools.run(
      {
        tool: 'devicectl',
        args: ['list', 'devices', '--json-output', temporaryFile.path],
        allowFailure: true,
        timeoutMs: IOS_DEVICECTL_LIST_TIMEOUT_MS,
      },
      scope.signal,
    );
    if (result.exitCode !== 0) return [];
    const payload = JSON.parse(await temporaryFile.readText()) as DevicectlListDevicesPayload;
    return (payload.result?.devices ?? []).flatMap((device) => {
      const mapped = mapDevicectlAppleDevice(device);
      return mapped ? [mapped] : [];
    });
  } catch {
    scope.signal.throwIfAborted();
    return [];
  } finally {
    try {
      await temporaryFile?.[Symbol.asyncDispose]();
    } catch {
      // Discovery is best-effort; cleanup failure must not mask an available fallback.
    }
  }
}

async function listPhysicalDevicesFromXctrace(
  host: DeviceInventoryHostFor<'apple'>,
  scope: PlatformRequestScope,
): Promise<DeviceInfo[]> {
  try {
    const result = await host.appleTools.run(
      { tool: 'xctrace', args: ['list', 'devices'], allowFailure: true },
      scope.signal,
    );
    return result.exitCode === 0 ? parseXctracePhysicalAppleDevices(result.stdout) : [];
  } catch {
    scope.signal.throwIfAborted();
    return [];
  }
}

function mergeAppleDevices(primary: DeviceInfo[], supplemental: DeviceInfo[]): DeviceInfo[] {
  const ids = new Set(primary.map((device) => device.id));
  const merged = [...primary];
  for (const device of supplemental) {
    if (ids.has(device.id)) continue;
    ids.add(device.id);
    merged.push(device);
  }
  return merged;
}
