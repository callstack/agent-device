import type { SnapshotState } from '@agent-device/kernel/snapshot';
import { extractNodeText, isMeaningfulLabel } from '@agent-device/contracts/snapshot';

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

export function resolveRefLabel(
  node: SnapshotState['nodes'][number],
  nodes: SnapshotState['nodes'],
): string | undefined {
  const primary = extractNodeText(node);
  if (primary && isMeaningfulLabel(primary)) return primary;
  return findNearestMeaningfulLabel(node, nodes);
}

function findNearestMeaningfulLabel(
  target: SnapshotState['nodes'][number],
  nodes: SnapshotState['nodes'],
): string | undefined {
  if (!target.rect) return undefined;
  const targetY = target.rect.y + target.rect.height / 2;
  let best: { label: string; distance: number } | null = null;
  for (const node of nodes) {
    if (!node.rect) continue;
    const label = extractNodeText(node);
    if (!label || !isMeaningfulLabel(label)) continue;
    const nodeY = node.rect.y + node.rect.height / 2;
    const distance = Math.abs(nodeY - targetY);
    if (!best || distance < best.distance) {
      best = { label, distance };
    }
  }
  return best?.label;
}
