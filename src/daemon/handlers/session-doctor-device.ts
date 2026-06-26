import { listDeviceInventory } from '../../core/dispatch-resolve.ts';
import type { DeviceInfo, DeviceTarget, Platform, PlatformSelector } from '../../utils/device.ts';
import {
  normalizePlatformSelector,
  resolveAppleSimulatorSetPathForSelector,
} from '../../utils/device.ts';
import {
  resolveAndroidSerialAllowlist,
  resolveIosSimulatorDeviceSetPath,
} from '../../utils/device-isolation.ts';
import { AppError, normalizeError } from '../../utils/errors.ts';
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
  const platform = normalizePlatformSelector(flags.platform) ?? session?.device.platform;
  const target = flags.target ?? session?.device.target;
  if (target && !platform) {
    throw new AppError(
      'INVALID_ARGS',
      'Device target selector requires --platform. Use --platform ios|macos|android|linux|apple with --target mobile|tv|desktop.',
    );
  }
  const iosSimulatorSetPath = resolveAppleSimulatorSetPathForSelector({
    simulatorSetPath: resolveIosSimulatorDeviceSetPath(flags.iosSimulatorDeviceSet),
    platform,
    target,
  });
  const androidSerialAllowlist = resolveAndroidSerialAllowlist(flags.androidDeviceAllowlist);
  return {
    platform,
    target,
    deviceName: flags.device,
    udid: flags.udid,
    serial: flags.serial,
    iosSimulatorSetPath,
    androidSerialAllowlist: androidSerialAllowlist
      ? Array.from(androidSerialAllowlist).sort()
      : undefined,
  };
}

function filterInventoryForSelector(
  devices: DeviceInfo[],
  selector: ReturnType<typeof deviceInventorySelector>,
): DeviceInfo[] {
  return devices.filter((device) => deviceMatchesSelector(device, selector));
}

async function readDoctorDeviceInventory(
  selector: ReturnType<typeof deviceInventorySelector>,
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
  return { devices, failures: devices.length === 0 ? failures : [] };
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

function deviceMatchesSelector(
  device: DeviceInfo,
  selector: ReturnType<typeof deviceInventorySelector>,
): boolean {
  return [
    optionalPlatformMatches(selector.platform, device),
    optionalValueMatches(selector.target, device.target),
    optionalValueMatches(selector.deviceName, device.name),
    optionalValueMatches(selector.udid, device.id),
    optionalValueMatches(selector.serial, device.id),
  ].every(Boolean);
}

function optionalPlatformMatches(
  selector: PlatformSelector | undefined,
  device: DeviceInfo,
): boolean {
  return selector === undefined || deviceMatchesPlatform(device, selector);
}

function optionalValueMatches<T>(expected: T | undefined, actual: T | undefined): boolean {
  return expected === undefined || actual === expected;
}

function deviceMatchesPlatform(device: DeviceInfo, selector: PlatformSelector): boolean {
  if (selector === 'apple') return device.platform === 'ios' || device.platform === 'macos';
  return device.platform === selector;
}

function deviceInventorySummary(
  devices: DeviceInfo[],
  selector: Pick<ReturnType<typeof deviceInventorySelector>, 'platform' | 'target'>,
  failures: DoctorInventoryFailure[],
): string {
  if (devices.length === 0) {
    if (failures.length > 0) {
      return `No ${deviceInventoryLabel(selector)} devices found; ${inventoryFailureSummary(failures)}.`;
    }
    return `No ${deviceInventoryLabel(selector)} devices found.`;
  }
  const booted = devices.filter((device) => device.booted === true).length;
  return `${devices.length} ${deviceInventoryLabel(selector)} ${plural(
    devices.length,
    'device',
  )} available; ${booted} booted.`;
}

function deviceInventoryLabel(
  selector: Pick<ReturnType<typeof deviceInventorySelector>, 'platform' | 'target'>,
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

function deviceInventoryCommand(
  selector: Pick<ReturnType<typeof deviceInventorySelector>, 'platform'>,
): string {
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
