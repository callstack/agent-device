import { formatRole } from '@agent-device/kernel/snapshot';
import type { SnapshotNode } from '@agent-device/kernel/snapshot';
import type { SnapshotState } from '@agent-device/contracts/snapshot-model';

export type SnapshotNodeFixture = Omit<SnapshotNode, 'ref' | 'kind'> & {
  ref?: string;
};

export function makeSnapshot(nodes: SnapshotNodeFixture[]): SnapshotState {
  return {
    createdAt: Date.now(),
    nodes: nodes.map((node) => ({
      ref: `e${node.index}`,
      ...node,
      kind: formatRole(node.type ?? 'Element'),
    })),
  };
}
