import {
  buildDeviceInventoryRequestFromFlags,
  listDeviceInventory,
} from '../../core/dispatch-resolve.ts';
import {
  countDeviceInventoryByGroup,
  LOCAL_DEVICE_INVENTORY_PLATFORM_SELECTORS,
  type DeviceInventoryGroup,
  type DeviceInventoryRequest,
} from '../../contracts/device-inventory.ts';
import {
  matchesDeviceSelector,
  publicPlatformString,
  type DeviceInfo,
  type DeviceTarget,
  type PlatformSelector,
  type PublicPlatform,
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

type DoctorInventoryFailure = {
  platform: PlatformSelector;
  message: string;
  hint?: string;
  code?: string;
};

export async function appendDeviceInventoryCheck(
  checks: DoctorCheck[],
  req: DaemonRequest,
  session: SessionState | undefined,
): Promise<DoctorDeviceInventory | undefined> {
  const selector = deviceInventorySelector(req, session);
  try {
    const inventory = await readDoctorDeviceInventory(selector);
    const devices = filterInventoryForSelector(inventory.devices, selector);
    appendDoctorCheck(checks, {
      id: 'device',
      status: devices.length === 0 ? 'fail' : 'pass',
      summary: deviceInventorySummary(devices, selector, inventory.failures),
      hint: devices.length === 0 ? deviceInventoryFailureHint(inventory.failures) : undefined,
      command: devices.length === 0 ? deviceInventoryCommand(selector) : undefined,
      evidence: deviceInventoryEvidence(devices, inventory.failures),
    });
    if (devices.length > 0) {
      appendInventoryFailureChecks(checks, inventory.failures);
    }
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
        // approach (b): emit the PUBLIC leaf platform (ios/macos), never the internal `apple`.
        platform: publicPlatformString(device),
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

async function readDoctorDeviceInventory(
  selector: DeviceInventoryRequest,
): Promise<{ devices: DeviceInfo[]; failures: DoctorInventoryFailure[] }> {
  if (selector.platform) {
    return { devices: await listDeviceInventory(selector), failures: [] };
  }

  const devices: DeviceInfo[] = [];
  const failures: DoctorInventoryFailure[] = [];
  for (const platform of LOCAL_DEVICE_INVENTORY_PLATFORM_SELECTORS) {
    try {
      devices.push(...(await listDeviceInventory({ ...selector, platform })));
    } catch (error) {
      failures.push(inventoryFailure(platform, error));
    }
  }
  return { devices, failures };
}

function appendInventoryFailureChecks(
  checks: DoctorCheck[],
  failures: DoctorInventoryFailure[],
): void {
  for (const failure of failures) {
    appendDoctorCheck(checks, inventoryFailureCheck(failure));
  }
}

function inventoryFailureCheck(failure: DoctorInventoryFailure): DoctorCheck {
  return {
    id: `device-${failure.platform}`,
    status: 'warn',
    summary: `${platformLabel(failure.platform)} device inventory could not be read: ${failure.message}`,
    hint:
      failure.hint ??
      `Check the ${platformLabel(failure.platform)} toolchain, or scope with --platform to skip it.`,
    evidence: { platform: failure.platform, code: failure.code },
  };
}

function inventoryFailure(platform: PlatformSelector, error: unknown): DoctorInventoryFailure {
  const normalized = normalizeError(error);
  return {
    platform,
    message: normalized.message,
    hint: normalized.hint,
    code: normalized.code,
  };
}

function deviceInventorySummary(
  devices: DeviceInfo[],
  selector: Pick<DeviceInventoryRequest, 'platform' | 'target'>,
  failures: DoctorInventoryFailure[],
): string {
  if (devices.length === 0) {
    if (failures.length > 0) {
      return `No ${deviceInventoryLabel(selector)} devices found; ${inventoryFailureSummary(failures)}.`;
    }
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

function inventoryFailureSummary(failures: DoctorInventoryFailure[]): string {
  return failures
    .slice(0, 2)
    .map((failure) => `${platformLabel(failure.platform)} inventory failed: ${failure.message}`)
    .join('; ');
}

function deviceInventoryFailureHint(failures: DoctorInventoryFailure[]): string {
  return (
    failures.find((failure) => failure.hint)?.hint ??
    'Start or create a simulator/emulator, connect a device, or adjust --platform/--target/--device selectors.'
  );
}

function deviceInventorySummaryBreakdown(
  devices: DeviceInfo[],
  selector: Pick<DeviceInventoryRequest, 'platform' | 'target'>,
): string | undefined {
  if (selector.platform || selector.target) return undefined;
  const groups = countDeviceInventoryByGroup(devices);
  const labels = deviceInventoryGroupLabels();
  return (['android', 'apple', 'linux', 'web'] as const)
    .flatMap((group) => {
      const entry = groups[group];
      return entry.available > 0
        ? [`${labels[group]} ${entry.available} available, ${entry.booted} booted`]
        : [];
    })
    .join('; ');
}

function deviceInventoryGroupLabels(): Record<DeviceInventoryGroup, string> {
  return {
    android: 'Android',
    apple: 'Apple',
    linux: 'Linux',
    web: 'web',
  };
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

function deviceInventoryEvidence(
  devices: DeviceInfo[],
  failures: DoctorInventoryFailure[],
): Record<string, unknown> {
  // Key by the PUBLIC leaf platform (ios/macos/android/...), never the internal
  // collapsed `apple`, so the doctor breakdown stays a machine-stable output and
  // Apple devices split into ios vs macos.
  const byPlatform = new Map<PublicPlatform, { available: number; booted: number }>();
  for (const device of devices) {
    const key = publicPlatformString(device);
    const entry = byPlatform.get(key) ?? { available: 0, booted: 0 };
    entry.available += 1;
    if (device.booted === true) entry.booted += 1;
    byPlatform.set(key, entry);
  }
  return {
    available: devices.length,
    booted: devices.filter((device) => device.booted === true).length,
    byPlatform: Object.fromEntries(
      [...byPlatform.entries()].sort(([a], [b]) => a.localeCompare(b)),
    ),
    ...(failures.length > 0 ? { failures } : {}),
  };
}
