import type { SnapshotState } from '@agent-device/kernel/snapshot';

export function findNodeByLabel(nodes: SnapshotState['nodes'], label: string) {
  const query = label.toLowerCase();
  return (
    nodes.find((node) => {
      const labelValue = (node.label ?? '').toLowerCase();
      const valueValue = (node.value ?? '').toLowerCase();
      const idValue = (node.identifier ?? '').toLowerCase();
      return labelValue.includes(query) || valueValue.includes(query) || idValue.includes(query);
    }) ?? null
  );
}
