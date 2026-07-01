import {
  buildDeviceInventoryRequestFromFlags,
  listDeviceInventory,
} from '../../core/dispatch-resolve.ts';
import type { DeviceInventoryRequest } from '../../core/platform-inventory.ts';
import {
  matchesDeviceSelector,
  type DeviceInfo,
  type DeviceTarget,
  type PlatformSelector,
} from '../../kernel/device.ts';
import { normalizeError } from '../../kernel/errors.ts';
import type { DaemonRequest, SessionState } from '../types.ts';
import type { DoctorCheck } from './session-doctor-types.ts';
import { appendDoctorCheck } from './session-doctor-output.ts';

export type DoctorDeviceInventory = {
  devices: DeviceInfo[];
  platform?: PlatformSelector;
  target?: DeviceTarget;
};

type DoctorInventoryGroup = 'android' | 'apple' | 'linux' | 'web';

export async function appendDeviceInventoryCheck(
  checks: DoctorCheck[],
  req: DaemonRequest,
  session: SessionState | undefined,
): Promise<DoctorDeviceInventory | undefined> {
  const selector = deviceInventorySelector(req, session);
  try {
    const devices = filterInventoryForSelector(await listDeviceInventory(selector), selector);
    appendDoctorCheck(checks, {
      id: 'device',
      status: devices.length === 0 ? 'fail' : 'pass',
      summary: deviceInventorySummary(devices, selector),
      hint:
        devices.length === 0
          ? 'Start or create a simulator/emulator, connect a device, or adjust --platform/--target/--device selectors.'
          : undefined,
      command: devices.length === 0 ? deviceInventoryCommand(selector) : undefined,
      evidence: deviceInventoryEvidence(devices),
    });
    return { devices, platform: selector.platform, target: selector.target };
  } catch (error) {
    const normalized = normalizeError(error);
    appendDoctorCheck(checks, {
      id: 'device',
      status: 'fail',
      summary: normalized.message,
      hint: normalized.hint,
      command: 'agent-device devices',
      evidence: { code: normalized.code, details: normalized.details },
    });
    return { devices: [], platform: selector.platform, target: selector.target };
  }
}

export function resolveDoctorDeviceForAppCheck(
  checks: DoctorCheck[],
  inventory: DoctorDeviceInventory | undefined,
  targetApp: string | undefined,
): DeviceInfo | undefined {
  if (!targetApp || !inventory) return undefined;
  const booted = inventory.devices.filter((device) => device.booted === true);
  if (booted.length === 1) return booted[0];

  appendDoctorCheck(checks, {
    id: 'target-app-device',
    status: 'fail',
    summary:
      booted.length === 0
        ? 'Target app check needs one booted device; none matched.'
        : `Target app check needs one booted device; ${booted.length} matched.`,
    hint:
      booted.length === 0
        ? 'Boot a device, or adjust --platform/--target/--device/--udid/--serial.'
        : 'Pass --platform/--target/--device/--udid/--serial so doctor checks the intended device.',
    command: inventory.platform
      ? `agent-device devices --platform ${inventory.platform}`
      : 'agent-device devices',
    evidence: {
      targetApp,
      booted: booted.map((device) => ({
        platform: device.platform,
        id: device.id,
        name: device.name,
      })),
    },
  });
  return undefined;
}

function deviceInventorySelector(req: DaemonRequest, session: SessionState | undefined) {
  const flags = req.flags ?? {};
  return buildDeviceInventoryRequestFromFlags({
    platform: flags.platform ?? session?.device.platform,
    target: flags.target ?? session?.device.target,
    device: flags.device,
    udid: flags.udid,
    serial: flags.serial,
    iosSimulatorDeviceSet: flags.iosSimulatorDeviceSet,
    androidDeviceAllowlist: flags.androidDeviceAllowlist,
  });
}

function filterInventoryForSelector(
  devices: DeviceInfo[],
  selector: DeviceInventoryRequest,
): DeviceInfo[] {
  return devices.filter((device) =>
    matchesDeviceSelector(device, selector, { includeExplicitSelectors: true }),
  );
}

function deviceInventorySummary(
  devices: DeviceInfo[],
  selector: Pick<DeviceInventoryRequest, 'platform' | 'target'>,
): string {
  if (devices.length === 0) {
    return `No ${deviceInventoryLabel(selector)} devices found.`;
  }
  const booted = devices.filter((device) => device.booted === true).length;
  const summary = `${devices.length} ${deviceInventoryLabel(selector)} ${plural(
    devices.length,
    'device',
  )} available; ${booted} booted`;
  const platformBreakdown = deviceInventorySummaryBreakdown(devices, selector);
  return platformBreakdown ? `${summary} (${platformBreakdown}).` : `${summary}.`;
}

function deviceInventoryLabel(
  selector: Pick<DeviceInventoryRequest, 'platform' | 'target'>,
): string {
  const platform = selector.platform ? platformLabel(selector.platform) : 'local';
  return selector.target ? `${platform} ${selector.target}` : platform;
}

function deviceInventorySummaryBreakdown(
  devices: DeviceInfo[],
  selector: Pick<DeviceInventoryRequest, 'platform' | 'target'>,
): string | undefined {
  if (selector.platform || selector.target) return undefined;
  const groups = deviceInventoryGroups(devices);
  return (['android', 'apple', 'linux', 'web'] as const)
    .flatMap((group) => {
      const entry = groups[group];
      return entry.available > 0
        ? [`${entry.label} ${entry.available} available, ${entry.booted} booted`]
        : [];
    })
    .join('; ');
}

function deviceInventoryGroups(
  devices: DeviceInfo[],
): Record<DoctorInventoryGroup, { label: string; available: number; booted: number }> {
  const groups = {
    android: { label: 'Android', available: 0, booted: 0 },
    apple: { label: 'Apple', available: 0, booted: 0 },
    linux: { label: 'Linux', available: 0, booted: 0 },
    web: { label: 'web', available: 0, booted: 0 },
  };
  for (const device of devices) {
    const group =
      device.platform === 'ios' || device.platform === 'macos'
        ? groups.apple
        : groups[device.platform];
    group.available += 1;
    if (device.booted === true) group.booted += 1;
  }
  return groups;
}

function platformLabel(platform: PlatformSelector): string {
  if (platform === 'ios') return 'iOS';
  if (platform === 'macos') return 'macOS';
  if (platform === 'android') return 'Android';
  if (platform === 'linux') return 'Linux';
  if (platform === 'web') return 'web';
  return 'Apple';
}

function plural(count: number, singular: string): string {
  return count === 1 ? singular : `${singular}s`;
}

function deviceInventoryCommand(selector: Pick<DeviceInventoryRequest, 'platform'>): string {
  return selector.platform
    ? `agent-device devices --platform ${selector.platform}`
    : 'agent-device devices';
}

function deviceInventoryEvidence(devices: DeviceInfo[]): Record<string, unknown> {
  const groups = deviceInventoryGroups(devices);
  return {
    available: devices.length,
    booted: devices.filter((device) => device.booted === true).length,
    byPlatform: {
      android: groups.android,
      apple: groups.apple,
      linux: groups.linux,
      web: groups.web,
    },
  };
}
