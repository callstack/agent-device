import {
  buildDeviceInventoryRequestFromFlags,
  listDeviceInventory,
} from '../../core/dispatch-resolve.ts';
import type { DeviceInventoryRequest } from '../../core/platform-inventory.ts';
import {
  matchesDeviceSelector,
  type DeviceInfo,
  type DeviceTarget,
  type Platform,
  type PlatformSelector,
} from '../../kernel/device.ts';
import { normalizeError } from '../../kernel/errors.ts';
import type { DaemonRequest, SessionState } from '../types.ts';
import type { DoctorCheck, DoctorOptions } from './session-doctor-types.ts';
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

type DoctorInventoryGroup = 'android' | 'apple' | 'linux' | 'web';

export async function appendDeviceInventoryCheck(
  checks: DoctorCheck[],
  req: DaemonRequest,
  session: SessionState | undefined,
): Promise<DoctorDeviceInventory | undefined> {
  try {
    const selector = deviceInventorySelector(req, session);
    const inventory = await readDoctorDeviceInventory(selector);
    const devices = filterInventoryForSelector(inventory.devices, selector);
    appendDoctorCheck(checks, {
      id: 'device',
      status: devices.length === 0 ? 'fail' : 'pass',
      summary: deviceInventorySummary(devices, selector, inventory.failures),
      hint:
        devices.length === 0
          ? (inventory.failures.find((failure) => failure.hint)?.hint ??
            'Start or create a simulator/emulator, connect a device, or adjust --platform/--target/--device selectors.')
          : undefined,
      command: devices.length === 0 ? deviceInventoryCommand(selector) : undefined,
      evidence: deviceInventoryEvidence(devices, inventory.failures),
    });
    // When some platforms had devices, the main check passes — but a platform whose
    // inventory threw (e.g. a broken Xcode or Android SDK) must not be silently hidden.
    if (devices.length > 0) {
      for (const failure of inventory.failures) {
        appendDoctorCheck(checks, inventoryFailureCheck(failure));
      }
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
    return undefined;
  }
}

export function platformScopeChecks(device: DeviceInfo, options: DoctorOptions): DoctorCheck[] {
  if (
    (options.kind === 'react-native' || options.kind === 'expo') &&
    device.platform !== 'ios' &&
    device.platform !== 'android'
  ) {
    return [
      {
        id: 'platform-scope',
        status: 'info',
        summary: `${options.kind} checks are app-mobile focused; ${device.platform} doctor covers device/session readiness only.`,
      },
    ];
  }
  if (device.platform === 'android' && options.kind !== 'auto') {
    return [
      {
        id: 'android-routing',
        status: 'info',
        summary:
          'Android URL opens can use host localhost automatically; package launches may still need adb reverse.',
        command: `adb -s ${device.id} reverse tcp:${options.metroPort} tcp:${options.metroPort}`,
      },
    ];
  }
  return [];
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
  for (const platform of ['android', 'apple', 'linux'] as const) {
    try {
      devices.push(...(await listDeviceInventory({ ...selector, platform })));
    } catch (error) {
      failures.push(inventoryFailure(platform, error));
    }
  }
  return { devices, failures };
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

function deviceInventoryEvidence(
  devices: DeviceInfo[],
  failures: DoctorInventoryFailure[],
): Record<string, unknown> {
  const byPlatform = new Map<Platform, { available: number; booted: number }>();
  for (const device of devices) {
    const entry = byPlatform.get(device.platform) ?? { available: 0, booted: 0 };
    entry.available += 1;
    if (device.booted === true) entry.booted += 1;
    byPlatform.set(device.platform, entry);
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
