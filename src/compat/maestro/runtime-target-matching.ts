import type { SnapshotNode, SnapshotState } from '../../kernel/snapshot.ts';
import type { MaestroSelector } from './program-ir.ts';
import {
  matchesMaestroTypedSelector,
  type MaestroSelectorMatchOptions,
} from './runtime-target-policy.ts';

/** Resolve a source-preserving Maestro selector without stringifying it. */
export function findMaestroTypedSelectorMatches(
  snapshot: SnapshotState,
  selector: MaestroSelector,
  options: MaestroSelectorMatchOptions = {},
): SnapshotNode[] {
  return snapshot.nodes.filter((node) => matchesMaestroTypedSelector(node, selector, options));
}
