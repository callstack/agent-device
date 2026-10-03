import type { RawSnapshotNode } from '@agent-device/kernel/snapshot';
import { IosSnapshotEngineError } from './types.ts';

export function validateIosSnapshotGraph(nodes: readonly RawSnapshotNode[]): void {
  const positions = new Map<number, number>();
  for (const [position, node] of nodes.entries()) {
    if (!Number.isInteger(node.index) || node.index < 0 || positions.has(node.index)) {
      throw new IosSnapshotEngineError(
        'malformed-graph',
        'iOS snapshot graph contains a duplicate or invalid node index',
        { index: node.index },
      );
    }
    positions.set(node.index, position);
    if (node.depth !== undefined && (!Number.isInteger(node.depth) || node.depth < 0)) {
      throw new IosSnapshotEngineError(
        'malformed-graph',
        'iOS snapshot graph contains an invalid node depth',
        { index: node.index, field: 'depth' },
      );
    }
  }

  for (const [position, node] of nodes.entries()) {
    if (node.parentIndex === undefined) continue;
    const parentPosition = positions.get(node.parentIndex);
    if (parentPosition === undefined || parentPosition >= position) {
      throw new IosSnapshotEngineError(
        'malformed-graph',
        'iOS snapshot graph parent must precede its child',
        { index: node.index, parentIndex: node.parentIndex },
      );
    }
  }
}
