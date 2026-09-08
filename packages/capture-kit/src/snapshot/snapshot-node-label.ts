import type { SnapshotState } from '@agent-device/kernel/snapshot';
import { matchesSnapshotScope } from '@agent-device/contracts/snapshot';

/** First document-order node whose label/value/identifier contains `label` (the scope rule). */
export function findNodeByLabel(nodes: SnapshotState['nodes'], label: string) {
  return nodes.find((node) => matchesSnapshotScope(node, label)) ?? null;
}
