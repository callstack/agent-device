import { AppError } from '@agent-device/kernel/errors';
import type { CommandFlags } from '../../core/dispatch.ts';
import type { ReplayTestPlatform, ReplayTestTarget } from './session-test-types.ts';

export type ReplayTestShardMode = 'all' | 'split';

/**
 * The device a shard runs against, in neutral vocabulary.
 *
 * The scheduler reads `id`/`name` for session labels and progress metadata. `platform` and
 * `target` are here because the host needs them to bind a nested request, and both are already
 * neutral kernel types — so `DeviceInfo` itself never crosses into scheduling.
 */
export type ReplayTestShardTarget = Readonly<{
  id: string;
  name: string;
  platform: ReplayTestPlatform;
  target?: ReplayTestTarget;
}>;

export type ReplayTestShardContext = {
  shardIndex: number;
  shardCount: number;
  device: ReplayTestShardTarget;
};

/**
 * Resolves the devices a sharded run will use (#1478 P3b).
 *
 * Enumerating inventory, applying allowlists and simulator set paths, and rejecting a run with
 * too few devices are all host concerns. The scheduler decides how many shards there are and
 * which entries go to each; it never enumerates hardware.
 */
export type ReplayTestResolveShardTargets = (
  shardCount: number,
) => Promise<readonly ReplayTestShardTarget[]>;

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
  resolveShardTargets: ReplayTestResolveShardTargets,
): Promise<ReplayTestShardPlan<TEntry> | undefined> {
  const mode = readReplayTestShardMode(flags);
  if (!mode) return undefined;
  if (runnableEntries.length === 0) return undefined;

  const devices = await resolveShardTargets(mode.count);
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
