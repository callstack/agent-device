import type {
  ReplayTestShardContext,
  ReplayTestShardMode,
  ReplayTestResolveShardTargets,
} from '@agent-device/contracts/replay-test-execution';

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
