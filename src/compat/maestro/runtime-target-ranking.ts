import type { Rect, SnapshotNode } from '../../kernel/snapshot.ts';

export function selectMaestroSnapshotMatch(
  matches: SnapshotNode[],
  index: number | undefined,
): { node: SnapshotNode; rect: Rect } | null {
  const selected = index === undefined ? matches.find(hasUsableRect) : matches[index];
  if (!selected || !hasUsableRect(selected)) return null;
  return { node: selected, rect: selected.rect };
}

function hasUsableRect(node: SnapshotNode): node is SnapshotNode & { rect: Rect } {
  const rect = node.rect;
  return Boolean(
    rect &&
    Number.isFinite(rect.x) &&
    Number.isFinite(rect.y) &&
    Number.isFinite(rect.width) &&
    Number.isFinite(rect.height) &&
    rect.width > 0 &&
    rect.height > 0,
  );
}
