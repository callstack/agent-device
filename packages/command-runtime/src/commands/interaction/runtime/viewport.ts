import { AppError } from '@agent-device/kernel/errors';
import type { Rect, SnapshotNode } from '@agent-device/kernel/snapshot';
import type { SnapshotState } from '@agent-device/contracts/snapshot-model';
import { createSnapshotVisibility } from '@agent-device/contracts/snapshot';
import { assertSnapshotScreenOrigin } from '@agent-device/contracts/capture';

export async function resolveVisibleSnapshotViewport(
  nodes: SnapshotState['nodes'],
  action: string,
): Promise<Rect> {
  await assertSnapshotScreenOrigin(nodes, action);
  const visibility = createSnapshotVisibility(nodes);
  const visibleRects = nodes
    .filter(visibility.isVisibleInEffectiveViewport)
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
