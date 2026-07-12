import type { SnapshotNode, SnapshotState } from '../../../kernel/snapshot.ts';

export const IOS_TAB_FRAME = { referenceWidth: 402, referenceHeight: 874 } as const;

export type SnapshotNodeFixture = Omit<SnapshotNode, 'ref'> & { ref?: string };

export function makeSnapshot(nodes: SnapshotNodeFixture[]): SnapshotState {
  return {
    createdAt: Date.now(),
    nodes: nodes.map((node) => ({ ref: `e${node.index}`, ...node })),
  };
}
