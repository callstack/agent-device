import { listDeviceInventory, type DeviceInventoryRequest } from '../../core/dispatch-resolve.ts';
import {
  resolveAndroidSerialAllowlist,
  resolveIosSimulatorDeviceSetPath,
} from '../../utils/device-isolation.ts';
import {
  isMobilePlatform,
  matchesPlatformSelector,
  resolveAppleSimulatorSetPathForSelector,
  type DeviceInfo,
} from '../../kernel/device.ts';
import { AppError } from '../../kernel/errors.ts';
import type { CommandFlags } from '../../core/dispatch.ts';

export type ReplayTestShardMode = 'all' | 'split';

export type ReplayTestShardContext = {
  shardIndex: number;
  shardCount: number;
  device: DeviceInfo;
};

export type ReplayTestShardPlan<TEntry> = {
  mode: ReplayTestShardMode;
  shardCount: number;
  total: number;
  shards: Array<ReplayTestShardContext & { entries: TEntry[] }>;
};

export async function buildReplayTestShardPlan<TEntry>(
  flags: CommandFlags | undefined,
  runnableEntries: TEntry[],
  skippedCount: number,
): Promise<ReplayTestShardPlan<TEntry> | undefined> {
  const mode = readReplayTestShardMode(flags);
  if (!mode) return undefined;
  if (runnableEntries.length === 0) return undefined;

  const devices = await resolveReplayTestShardDevices(flags, mode.count);
  return {
    mode: mode.kind,
    shardCount: mode.count,
    total:
      skippedCount +
      (mode.kind === 'all' ? runnableEntries.length * mode.count : runnableEntries.length),
    shards: devices.map((device, index) => ({
      shardIndex: index,
      shardCount: mode.count,
      device,
      entries:
        mode.kind === 'all'
          ? runnableEntries
          : runnableEntries.filter((_entry, entryIndex) => entryIndex % mode.count === index),
    })),
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

function readReplayTestShardMode(
  flags: CommandFlags | undefined,
): { kind: ReplayTestShardMode; count: number } | undefined {
  const shardAll = readPositiveShardCount(flags?.shardAll, '--shard-all');
  const shardSplit = readPositiveShardCount(flags?.shardSplit, '--shard-split');
  if (shardAll !== undefined && shardSplit !== undefined) {
    throw new AppError('INVALID_ARGS', '--shard-all and --shard-split are mutually exclusive');
  }
  if (shardAll !== undefined) return { kind: 'all', count: shardAll };
  if (shardSplit !== undefined) return { kind: 'split', count: shardSplit };
  return undefined;
}

function readPositiveShardCount(value: unknown, flagName: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new AppError('INVALID_ARGS', `${flagName} requires a positive integer`);
  }
  return value;
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
  if (!isMobilePlatform(device.platform)) return false;
  return device.booted !== false;
}

function isShardDeviceCandidate(device: DeviceInfo, flags: CommandFlags | undefined): boolean {
  if (!matchesPlatformSelector(device.platform, flags?.platform)) return false;
  if (flags?.target && (device.target ?? 'mobile') !== flags.target) return false;
  return true;
}

function normalizeDeviceName(value: string): string {
  return value.toLowerCase().replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
}

function compareShardDevices(a: DeviceInfo, b: DeviceInfo): number {
  return a.id.localeCompare(b.id);
}
