import { AppError } from '../../../kernel/errors.ts';
import type { Rect, SnapshotNode, SnapshotState } from '../../../kernel/snapshot.ts';
import { isNodeVisibleInEffectiveViewport } from '../../../snapshot/mobile-snapshot-semantics.ts';

export function resolveVisibleSnapshotViewport(
  nodes: SnapshotState['nodes'],
  action: string,
): Rect {
  const visibleRects = nodes
    .filter((node) => isNodeVisibleInEffectiveViewport(node, nodes))
    .map((node) => node.rect)
    .filter(isUsableRect);
  const rects =
    visibleRects.length > 0 ? visibleRects : nodes.map((node) => node.rect).filter(isUsableRect);
  if (rects.length === 0) {
    throw new AppError('COMMAND_FAILED', `Cannot infer viewport for ${action}`);
  }
  const minX = Math.min(...rects.map((rect) => rect.x));
  const minY = Math.min(...rects.map((rect) => rect.y));
  const maxX = Math.max(...rects.map((rect) => rect.x + rect.width));
  const maxY = Math.max(...rects.map((rect) => rect.y + rect.height));
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

function isUsableRect(rect: SnapshotNode['rect']): rect is NonNullable<SnapshotNode['rect']> {
  return Boolean(rect && rect.width > 0 && rect.height > 0);
}
