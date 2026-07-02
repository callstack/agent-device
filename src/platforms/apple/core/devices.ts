import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AppError } from '../../../kernel/errors.ts';
import {
  isIosFamily,
  sortAppleDevicesForSelection,
  type AppleOS,
  type DeviceInfo,
  type DeviceTarget,
} from '../../../kernel/device.ts';
import { resolveIosSimulatorDeviceSetPath } from '../../../utils/device-isolation.ts';
import { buildHostMacDevice } from '../os/macos/devices.ts';
import { buildSimctlArgs } from './simctl.ts';
import { markSimulatorBooted } from './simulator.ts';
import { resolveAppleToolProvider, runXcrun } from './tool-provider.ts';

export { createLocalAppleToolProvider, withAppleToolProvider } from './tool-provider.ts';

const IOS_DEVICECTL_LIST_TIMEOUT_MS = 8_000;
const APPLE_PRODUCT_TYPE_PATTERN = /^(iphone|ipad|ipod|appletv|realitydevice)/i;
const APPLE_IPAD_PATTERN = /ipad/i;
const APPLE_VISION_PATTERN = /\b(apple vision|vision pro|xros|visionos|realitydevice)\b/i;
const APPLE_MOBILE_LABEL_PATTERN = /\b(iphone|ipad|ipod)\b/i;
const APPLE_TV_PRODUCT_TYPE_PATTERN = /^appletv/i;
const APPLE_TV_LABEL_HINTS = ['apple tv', 'appletv', 'tvos'] as const;

type SimctlDeviceRecord = {
  name: string;
  udid: string;
  state: string;
  isAvailable: boolean;
  // Stable simulator device-type id (e.g.
  // com.apple.CoreSimulator.SimDeviceType.iPad-Pro-11-inch-M4). Preferred over
  // the user-editable display name when classifying the Apple OS.
  deviceTypeIdentifier?: string;
};

type SimctlListDevicesPayload = {
  devices: Record<string, SimctlDeviceRecord[]>;
};

type DevicectlAppleDevice = {
  identifier?: string;
  name?: string;
  hardwareProperties?: { platform?: string; udid?: string; productType?: string };
  deviceProperties?: { name?: string; productType?: string; deviceType?: string };
  connectionProperties?: { tunnelState?: string };
};

type DevicectlListDevicesPayload = {
  result?: {
    devices?: DevicectlAppleDevice[];
  };
};

type IosDeviceDiscoveryOptions = {
  simulatorSetPath?: string;
  udid?: string;
};

const XCTRACE_SECTION_HEADER_PATTERN = /^==\s*(.+?)\s*==$/;
const XCTRACE_DEVICE_LINE_PATTERN = /^(?<name>.+?)\s+\[(?<id>[^[\]]+)\]\s*$/;

function normalizeAppleDescriptor(value: string | undefined): string {
  return (value ?? '').trim().toLowerCase();
}

function resolveAppleRuntime(runtime: string): string {
  return normalizeAppleDescriptor(runtime);
}

function resolveDevicectlApplePlatform(device: DevicectlAppleDevice): string {
  return normalizeAppleDescriptor(device.hardwareProperties?.platform);
}

function isAppleTvPlatform(platform: string): boolean {
  return platform.includes('tvos');
}

function isAppleVisionPlatform(platform: string): boolean {
  return platform.includes('xros') || platform.includes('visionos');
}

function resolveAppleTargetFromRuntime(runtime: string): DeviceTarget {
  return isAppleTvPlatform(resolveAppleRuntime(runtime)) ? 'tv' : 'mobile';
}

function isSupportedAppleRuntime(runtime: string): boolean {
  const normalized = resolveAppleRuntime(runtime);
  return (
    normalized.includes('ios') ||
    normalized.includes('tvos') ||
    normalized.includes('xros') ||
    normalized.includes('visionos')
  );
}

function isAppleTvLabel(value: string): boolean {
  const normalized = normalizeAppleDescriptor(value);
  return APPLE_TV_LABEL_HINTS.some((hint) => normalized.includes(hint));
}

function isAppleMobileLabel(value: string): boolean {
  return APPLE_MOBILE_LABEL_PATTERN.test(value.trim());
}

function resolveAppleTargetFromLabel(value: string): DeviceTarget | null {
  if (isAppleTvLabel(value)) return 'tv';
  if (isAppleMobileLabel(value) || APPLE_VISION_PATTERN.test(value)) return 'mobile';
  return null;
}

/**
 * Derives the explicit Apple OS discriminant at discovery from the already
 * resolved device target plus any available descriptors (product type and/or
 * names). This is strictly additive metadata: it never widens discovery
 * filters and never changes runner SDK/destination selection.
 *
 * tv targets map to tvOS; mobile targets split into iPadOS (when an iPad
 * descriptor is present) and iOS otherwise.
 */
function resolveAppleOs(target: DeviceTarget, descriptors: string[]): AppleOS {
  if (target === 'tv') return 'tvos';
  if (descriptors.some((descriptor) => APPLE_VISION_PATTERN.test(descriptor))) return 'visionos';
  if (descriptors.some((descriptor) => APPLE_IPAD_PATTERN.test(descriptor))) return 'ipados';
  return 'ios';
}

export function isAppleProductType(productType: string): boolean {
  return APPLE_PRODUCT_TYPE_PATTERN.test(productType.trim());
}

export function isAppleTvProductType(productType: string): boolean {
  return APPLE_TV_PRODUCT_TYPE_PATTERN.test(productType.trim());
}

function resolveDevicectlAppleLabels(device: DevicectlAppleDevice): string[] {
  return [
    device.name ?? '',
    device.deviceProperties?.name ?? '',
    device.deviceProperties?.deviceType ?? '',
  ];
}

function resolveDevicectlAppleProductType(device: DevicectlAppleDevice): string {
  return device.hardwareProperties?.productType ?? device.deviceProperties?.productType ?? '';
}

export function resolveAppleTargetFromDevicectlDevice(device: DevicectlAppleDevice): DeviceTarget {
  const platform = resolveDevicectlApplePlatform(device);
  if (isAppleTvPlatform(platform)) return 'tv';
  const productType = resolveDevicectlAppleProductType(device);
  if (isAppleTvProductType(productType)) return 'tv';
  return resolveDevicectlAppleLabels(device).some(isAppleTvLabel) ? 'tv' : 'mobile';
}

export function isSupportedAppleDevicectlDevice(device: DevicectlAppleDevice): boolean {
  const platform = resolveDevicectlApplePlatform(device);
  if (platform.includes('ios') || platform.includes('tvos') || isAppleVisionPlatform(platform)) {
    return true;
  }
  const productType = resolveDevicectlAppleProductType(device);
  if (isAppleProductType(productType)) return true;
  return resolveDevicectlAppleLabels(device).some(isAppleTvLabel);
}

type FindBootableSimulatorOptions = IosDeviceDiscoveryOptions & {
  target?: DeviceTarget;
};

/**
 * Finds an available iOS simulator by querying simctl directly.  This is used
 * as a fallback when `listIosDevices` returned no simulators (e.g. all filtered
 * out) or only a physical device.  Only simulators with `isAvailable: true` are
 * considered so the caller can safely boot the result.
 *
 * Returns `null` when no suitable simulator can be found.
 */
export async function findBootableIosSimulator(
  options: FindBootableSimulatorOptions = {},
): Promise<DeviceInfo | null> {
  const simulatorSetPath = resolveIosSimulatorDeviceSetPath(options.simulatorSetPath);
  const targetFilter = options.target;

  let simResult;
  try {
    simResult = await runXcrun(buildSimctlArgs(['list', 'devices', '-j'], { simulatorSetPath }));
  } catch {
    return null;
  }

  let payload: SimctlListDevicesPayload;
  try {
    payload = JSON.parse(simResult.stdout as string) as SimctlListDevicesPayload;
  } catch {
    return null;
  }

  const simulators = sortAppleDevicesForSelection(
    parseSimctlAppleDevices(payload, simulatorSetPath),
  );
  return simulators.find((simulator) => !targetFilter || simulator.target === targetFilter) ?? null;
}

function parseSimctlAppleDevices(
  payload: SimctlListDevicesPayload,
  simulatorSetPath: string | undefined,
): DeviceInfo[] {
  const devices: DeviceInfo[] = [];
  for (const [runtime, runtimes] of Object.entries(payload.devices)) {
    if (!isSupportedAppleRuntime(runtime)) continue;
    for (const device of runtimes) {
      if (!device.isAvailable) continue;
      const target = resolveAppleTargetFromRuntime(runtime);
      const parsed: DeviceInfo = {
        platform: 'apple',
        id: device.udid,
        name: device.name,
        kind: 'simulator',
        target,
        // Prefer the stable device-type id so a user-renamed iPad simulator is
        // still tagged iPadOS; fall back to the display name when it is absent.
        appleOs: resolveAppleOs(target, [device.deviceTypeIdentifier ?? '', device.name]),
        booted: device.state === 'Booted',
        ...(simulatorSetPath ? { simulatorSetPath } : {}),
      };
      if (parsed.booted) markSimulatorBooted(parsed);
      devices.push(parsed);
    }
  }
  return devices;
}

function mapDevicectlAppleDevices(payload: DevicectlListDevicesPayload): DeviceInfo[] {
  const devices: DeviceInfo[] = [];
  for (const device of payload.result?.devices ?? []) {
    if (!isSupportedAppleDevicectlDevice(device)) continue;
    const id = device.hardwareProperties?.udid ?? device.identifier ?? '';
    const name = device.name ?? device.deviceProperties?.name ?? id;
    if (!id) continue;
    const target = resolveAppleTargetFromDevicectlDevice(device);
    devices.push({
      platform: 'apple',
      id,
      name,
      kind: 'device',
      target,
      appleOs: resolveAppleOs(target, [
        resolveDevicectlAppleProductType(device),
        ...resolveDevicectlAppleLabels(device),
      ]),
      booted: true,
    });
  }
  return devices;
}

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

    const deviceMatch = XCTRACE_DEVICE_LINE_PATTERN.exec(line);
    const id = deviceMatch?.groups?.id?.trim() ?? '';
    const name = deviceMatch?.groups?.name?.trim() ?? '';
    if (!id || !name) continue;
    const target = resolveAppleTargetFromLabel(name);
    if (!target) continue;

    devices.push({
      platform: 'apple',
      id,
      name,
      kind: 'device',
      target,
      appleOs: resolveAppleOs(target, [name]),
      // xctrace lists currently connected devices in the "Devices" section.
      // The "Devices Offline" section is excluded above, so treating these as
      // booted preserves the existing physical-device selection semantics.
      booted: true,
    });
  }

  return devices;
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

async function listApplePhysicalDevicesFromDevicectl(): Promise<DeviceInfo[]> {
  let jsonPath: string | null = null;
  try {
    jsonPath = path.join(
      os.tmpdir(),
      `agent-device-devicectl-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
    );
    const devicectlResult = await runXcrun(
      ['devicectl', 'list', 'devices', '--json-output', jsonPath],
      {
        allowFailure: true,
        timeoutMs: IOS_DEVICECTL_LIST_TIMEOUT_MS,
      },
    );
    if (devicectlResult.exitCode !== 0) {
      return [];
    }
    const jsonText = await fs.readFile(jsonPath, 'utf8');
    return mapDevicectlAppleDevices(JSON.parse(jsonText) as DevicectlListDevicesPayload);
  } catch {
    // Ignore devicectl discovery failures so simulator and xctrace-based
    // Apple discovery can still succeed.
    return [];
  } finally {
    if (jsonPath) {
      await fs.rm(jsonPath, { force: true }).catch(() => {});
    }
  }
}

async function listApplePhysicalDevicesFromXctrace(): Promise<DeviceInfo[]> {
  try {
    const result = await runXcrun(['xctrace', 'list', 'devices'], { allowFailure: true });
    if (result.exitCode !== 0) return [];
    return parseXctracePhysicalAppleDevices(result.stdout);
  } catch {
    // Ignore xctrace failures so modern CoreDevice discovery remains the
    // source of truth when available.
    return [];
  }
}

export async function listAppleDevices(
  options: IosDeviceDiscoveryOptions = {},
): Promise<DeviceInfo[]> {
  if (process.platform !== 'darwin') {
    throw new AppError('UNSUPPORTED_PLATFORM', 'Apple tools are only available on macOS');
  }

  if (!(await resolveAppleToolProvider().whichCommand('xcrun'))) {
    throw new AppError('TOOL_MISSING', 'xcrun not found in PATH');
  }

  const simulatorSetPath = resolveIosSimulatorDeviceSetPath(options.simulatorSetPath);

  const simResult = await runXcrun(
    buildSimctlArgs(['list', 'devices', '-j'], { simulatorSetPath }),
  );
  let devices: DeviceInfo[] = [];
  try {
    const payload = JSON.parse(simResult.stdout as string) as SimctlListDevicesPayload;
    devices = parseSimctlAppleDevices(payload, simulatorSetPath);
  } catch (err) {
    throw new AppError('COMMAND_FAILED', 'Failed to parse simctl devices JSON', undefined, err);
  }

  devices.push(buildHostMacDevice());
  if (options.udid && devices.some((device) => isIosFamily(device) && device.id === options.udid)) {
    return devices;
  }

  // When a simulator set is configured, keep iOS discovery strictly scoped to that set.
  // Do not enumerate host-global physical devices, but keep the local Mac available
  // because desktop targeting is independent of simulator sets.
  if (simulatorSetPath) {
    return sortAppleDevicesForSelection(devices);
  }

  const [devicectlDevices, xctraceDevices] = await Promise.all([
    listApplePhysicalDevicesFromDevicectl(),
    listApplePhysicalDevicesFromXctrace(),
  ]);

  devices = mergeAppleDevices(devices, devicectlDevices);
  return sortAppleDevicesForSelection(mergeAppleDevices(devices, xctraceDevices));
}
