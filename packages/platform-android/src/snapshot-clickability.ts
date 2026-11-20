import type { SnapshotClickabilityEvidence } from '@agent-device/contracts/capture';
import type { AndroidBuiltSnapshot } from './ui-hierarchy.ts';

/** Preserve the helper's reported tap facts (clickable, long-clickable) across Android presentation. */
export function buildAndroidSnapshotClickabilityEvidence(
  snapshot: Pick<AndroidBuiltSnapshot, 'nodes' | 'sourceNodes'>,
): Extract<SnapshotClickabilityEvidence, { provider: 'android-helper' }> {
  const clickableByNodeIndex = new Map<number, boolean | undefined>();
  const longClickableByNodeIndex = new Map<number, boolean | undefined>();
  snapshot.nodes.forEach((node, position) => {
    const sourceNode = snapshot.sourceNodes[position];
    clickableByNodeIndex.set(node.index, sourceNode?.clickable);
    longClickableByNodeIndex.set(node.index, sourceNode?.passiveFacts?.longClickable);
  });
  return {
    kind: 'exact',
    provider: 'android-helper',
    clickableByNodeIndex,
    longClickableByNodeIndex,
  };
}
