import type { SnapshotNode, SnapshotState } from '../../kernel/snapshot.ts';
import type { MaestroSelector } from './program-ir.ts';
import { matchesMaestroTypedSelector } from './runtime-target-policy.ts';

/** Resolve a source-preserving Maestro selector without stringifying it. */
export function findMaestroTypedSelectorMatches(
  snapshot: SnapshotState,
  selector: MaestroSelector,
): SnapshotNode[] {
  return snapshot.nodes.filter((node) => matchesMaestroTypedSelector(node, selector));
}
