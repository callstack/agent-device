import type { Rect, SnapshotNode } from '../../kernel/snapshot.ts';
import { isPositiveFiniteRect } from '../../kernel/rect.ts';

export function selectMaestroSnapshotMatch(
  matches: SnapshotNode[],
  index: number | undefined,
): { node: SnapshotNode; rect: Rect } | null {
  const selected = index === undefined ? matches.find(hasUsableRect) : matches[index];
  if (!selected || !hasUsableRect(selected)) return null;
  return { node: selected, rect: selected.rect };
}

function hasUsableRect(node: SnapshotNode): node is SnapshotNode & { rect: Rect } {
  return isPositiveFiniteRect(node.rect);
}
