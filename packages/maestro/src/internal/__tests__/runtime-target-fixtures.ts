import { formatRole } from '@agent-device/kernel/snapshot';
import type { SnapshotNode, SnapshotState } from '@agent-device/kernel/snapshot';

export type SnapshotNodeFixture = Omit<SnapshotNode, 'ref' | 'kind'> & {
  ref?: string;
  kind?: string;
};

export function makeSnapshot(nodes: SnapshotNodeFixture[]): SnapshotState {
  return {
    createdAt: Date.now(),
    nodes: nodes.map((node) => ({
      ref: `e${node.index}`,
      kind: formatRole(node.type ?? 'Element'),
      ...node,
    })),
  };
}
