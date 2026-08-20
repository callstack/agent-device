import type { SnapshotClickabilityEvidence } from '@agent-device/contracts/capture';
import type { AndroidBuiltSnapshot } from './ui-hierarchy.ts';

/** Preserve the helper's reported clickable fact across Android presentation. */
export function buildAndroidSnapshotClickabilityEvidence(
  snapshot: Pick<AndroidBuiltSnapshot, 'nodes' | 'sourceNodes'>,
): SnapshotClickabilityEvidence {
  const clickableByNodeIndex = new Map<number, boolean | undefined>();
  snapshot.nodes.forEach((node, position) => {
    clickableByNodeIndex.set(node.index, snapshot.sourceNodes[position]?.clickable);
  });
  return {
    kind: 'exact',
    provider: 'android-helper',
    clickableByNodeIndex,
  };
}
