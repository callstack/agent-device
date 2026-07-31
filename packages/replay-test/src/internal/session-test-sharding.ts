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
  mode: Readonly<{ kind: ReplayTestShardMode; count: number }> | undefined,
  runnableEntries: TEntry[],
  skippedCount: number,
  resolveShardTargets: ReplayTestResolveShardTargets,
): Promise<ReplayTestShardPlan<TEntry> | undefined> {
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
