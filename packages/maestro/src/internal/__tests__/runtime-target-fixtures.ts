import type { SnapshotNode, SnapshotState } from '@agent-device/kernel/snapshot';

export type SnapshotNodeFixture = Omit<SnapshotNode, 'ref'> & { ref?: string };

export function makeSnapshot(nodes: SnapshotNodeFixture[]): SnapshotState {
  return {
    createdAt: Date.now(),
    nodes: nodes.map((node) => ({ ref: `e${node.index}`, ...node })),
  };
}
