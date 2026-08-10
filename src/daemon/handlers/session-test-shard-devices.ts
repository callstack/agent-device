import type { CommandFlags } from '@agent-device/contracts/command';
import type { DeviceInventoryRequest } from '@agent-device/contracts/device';
import { listDeviceInventory } from '../../core/device-inventory-context.ts';
import {
  resolveAndroidSerialAllowlist,
  resolveIosSimulatorDeviceSetPath,
} from '../../utils/device-isolation.ts';
import {
  isMobilePlatform,
  matchesPlatformSelector,
  resolveAppleSimulatorSetPathForSelector,
  type DeviceInfo,
} from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import type {
  ReplayTestShardMode,
  ReplayTestResolveShardTargets,
  ReplayTestShardContext,
  ReplayTestShardTarget,
} from '@agent-device/replay-test';

/**
 * The daemon adapter's shard-device binding (#1478 P3b).
 *
 * Inventory enumeration, allowlists, simulator set paths, explicit `--device` selectors, and
 * the too-few-devices error live here. The scheduler decides how many shards exist and which
 * entries each one runs; it never enumerates hardware.
 */
export function buildReplayTestShardTargetResolver(
  flags: CommandFlags | undefined,
): ReplayTestResolveShardTargets {
  return async (shardCount) => {
    const devices = await resolveReplayTestShardDevices(flags, shardCount);
    return devices.map(toReplayTestShardTarget);
  };
}

function toReplayTestShardTarget(device: DeviceInfo): ReplayTestShardTarget {
  // Implicit selection already filters to mobile; an explicit `--device` selector could in
  // principle name a web target, which is not a shardable device. Reject it here rather than
  // widening the neutral vocabulary to carry a platform the scheduler can never run.
  if (device.platform === 'web' || !isMobilePlatform(device)) {
    throw new AppError(
      'INVALID_ARGS',
      `test sharding requires a mobile device; ${device.id} is ${device.platform}`,
    );
  }
  return {
    id: device.id,
    name: device.name,
    platform: device.platform,
    ...(device.target !== undefined ? { target: device.target } : {}),
  };
}

export function buildReplayTestShardFlags(
  parentFlags: CommandFlags | undefined,
  shard: ReplayTestShardContext | undefined,
): CommandFlags | undefined {
  if (!shard) return parentFlags;
  const base = {
    ...(parentFlags ?? {}),
    device: undefined,
    udid: undefined,
    serial: undefined,
    platform: shard.device.platform,
    target: shard.device.target,
    shardAll: undefined,
    shardSplit: undefined,
    shardCount: shard.shardCount,
    shardIndex: shard.shardIndex,
  };
  return shard.device.platform === 'android'
    ? { ...base, serial: shard.device.id }
    : { ...base, udid: shard.device.id };
}

async function resolveReplayTestShardDevices(
  flags: CommandFlags | undefined,
  shardCount: number,
): Promise<DeviceInfo[]> {
  const explicitSelectors = explicitShardDeviceSelectors(flags);
  const inventory = await listDeviceInventory(buildReplayTestShardInventoryRequest(flags));
  const devices = selectReplayTestShardDevices(inventory, explicitSelectors, flags);

  if (devices.length < shardCount) {
    throw new AppError(
      'DEVICE_NOT_FOUND',
      `test sharding requires ${formatDeviceCount(shardCount)}, but only ${devices.length} matched`,
    );
  }
  return devices.slice(0, shardCount);
}

function buildReplayTestShardInventoryRequest(
  flags: CommandFlags | undefined,
): DeviceInventoryRequest {
  const androidSerialAllowlist = resolveAndroidSerialAllowlist(flags?.androidDeviceAllowlist);
  return {
    platform: flags?.platform,
    target: flags?.target,
    iosSimulatorSetPath: resolveAppleSimulatorSetPathForSelector({
      simulatorSetPath: resolveIosSimulatorDeviceSetPath(flags?.iosSimulatorDeviceSet),
      platform: flags?.platform,
      target: flags?.target,
    }),
    androidSerialAllowlist: androidSerialAllowlist
      ? Array.from(androidSerialAllowlist).sort()
      : undefined,
  };
}

function selectReplayTestShardDevices(
  inventory: DeviceInfo[],
  explicitSelectors: string[],
  flags: CommandFlags | undefined,
): DeviceInfo[] {
  if (explicitSelectors.length > 0) {
    return resolveExplicitShardDevices(inventory, explicitSelectors, flags);
  }
  return inventory
    .filter((device) => isImplicitShardDevice(device, flags))
    .sort(compareShardDevices);
}

function formatDeviceCount(count: number): string {
  return `${count} device${count === 1 ? '' : 's'}`;
}

function explicitShardDeviceSelectors(flags: CommandFlags | undefined): string[] {
  const raw = flags?.device;
  if (typeof raw !== 'string' || raw.trim().length === 0) return [];
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function resolveExplicitShardDevices(
  inventory: DeviceInfo[],
  selectors: string[],
  flags: CommandFlags | undefined,
): DeviceInfo[] {
  return selectors.map((selector) => {
    const normalizedSelector = normalizeDeviceName(selector);
    const match = inventory.find(
      (device) =>
        isShardDeviceCandidate(device, flags) &&
        (device.id === selector || normalizeDeviceName(device.name) === normalizedSelector),
    );
    if (!match) {
      throw new AppError('DEVICE_NOT_FOUND', `No shard device matched ${selector}`);
    }
    return match;
  });
}

function isImplicitShardDevice(device: DeviceInfo, flags: CommandFlags | undefined): boolean {
  if (!isShardDeviceCandidate(device, flags)) return false;
  if (!isMobilePlatform(device)) return false;
  return device.booted !== false;
}

function isShardDeviceCandidate(device: DeviceInfo, flags: CommandFlags | undefined): boolean {
  if (!matchesPlatformSelector(device, flags?.platform)) return false;
  if (flags?.target && (device.target ?? 'mobile') !== flags.target) return false;
  return true;
}

function normalizeDeviceName(value: string): string {
  return value.toLowerCase().replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
}

function compareShardDevices(a: DeviceInfo, b: DeviceInfo): number {
  return a.id.localeCompare(b.id);
}

/**
 * Reads the `--shard-all` / `--shard-split` selection from daemon flags (#1478 P3b).
 *
 * Flag parsing is host work; the scheduler receives a resolved mode and count.
 */
export function readReplayTestShardSelection(
  flags: CommandFlags | undefined,
): { mode: ReplayTestShardMode; count: number } | undefined {
  const shardAll = readPositiveShardCount(flags?.shardAll, '--shard-all');
  const shardSplit = readPositiveShardCount(flags?.shardSplit, '--shard-split');
  if (shardAll !== undefined && shardSplit !== undefined) {
    throw new AppError('INVALID_ARGS', '--shard-all and --shard-split are mutually exclusive');
  }
  if (shardAll !== undefined) return { mode: 'all', count: shardAll };
  if (shardSplit !== undefined) return { mode: 'split', count: shardSplit };
  return undefined;
}

function readPositiveShardCount(value: unknown, flagName: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new AppError('INVALID_ARGS', `${flagName} requires a positive integer`);
  }
  return value;
}
