import type { SnapshotNode, SnapshotState } from '@agent-device/kernel/snapshot';
import type { MaestroSelector } from './program-ir.ts';
import { resolveMaestroClickability } from './runtime-clickability.ts';
import { createMaestroResolver } from './runtime-target-ranking.ts';
import type { MaestroPositionRelation } from './runtime-target-position.ts';
import type { MaestroPlatform } from './runtime-target-policy.ts';

export function selectMaestroPositionMatches(
  snapshot: SnapshotState,
  relation: MaestroPositionRelation,
  anchor: MaestroSelector,
  platform?: MaestroPlatform,
): SnapshotNode[] {
  const clickability = platform ? resolveMaestroClickability(snapshot, platform) : undefined;
  return createMaestroResolver(snapshot, clickability).resolvePosition(relation, anchor);
}
