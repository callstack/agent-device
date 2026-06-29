import { centerOfRect, type RawSnapshotNode, type Rect } from '../kernel/snapshot.ts';

export function resolveViewportRect(nodes: RawSnapshotNode[], targetRect: Rect): Rect | null {
  const targetCenter = centerOfRect(targetRect);
  const rectNodes = nodes.filter((node) => hasValidRect(node.rect));
  const viewportNodes = rectNodes.filter((node) => {
    const type = (node.type ?? '').toLowerCase();
    return type.includes('application') || type.includes('window');
  });

  const containingViewport = pickLargestRect(
    viewportNodes
      .map((node) => node.rect as Rect)
      .filter((rect) => containsPoint(rect, targetCenter.x, targetCenter.y)),
  );
  if (containingViewport) return containingViewport;

  const viewportFallback = pickLargestRect(viewportNodes.map((node) => node.rect as Rect));
  if (viewportFallback) return viewportFallback;

  const genericContaining = pickLargestRect(
    rectNodes
      .map((node) => node.rect as Rect)
      .filter((rect) => containsPoint(rect, targetCenter.x, targetCenter.y)),
  );
  if (genericContaining) return genericContaining;

  return null;
}

export function isRectVisibleInViewport(targetRect: Rect, viewportRect: Rect): boolean {
  return (
    rangesOverlapInclusive(
      targetRect.x,
      targetRect.x + targetRect.width,
      viewportRect.x,
      viewportRect.x + viewportRect.width,
    ) &&
    rangesOverlapInclusive(
      targetRect.y,
      targetRect.y + targetRect.height,
      viewportRect.y,
      viewportRect.y + viewportRect.height,
    )
  );
}

function hasValidRect(rect: Rect | undefined): rect is Rect {
  if (!rect) return false;
  return (
    Number.isFinite(rect.x) &&
    Number.isFinite(rect.y) &&
    Number.isFinite(rect.width) &&
    Number.isFinite(rect.height)
  );
}

export function containsPoint(rect: Rect, x: number, y: number): boolean {
  return x >= rect.x && x <= rect.x + rect.width && y >= rect.y && y <= rect.y + rect.height;
}

export function pickLargestRect(rects: Rect[]): Rect | null {
  let best: Rect | null = null;
  let bestArea = -1;
  for (const rect of rects) {
    const area = rect.width * rect.height;
    if (area > bestArea) {
      best = rect;
      bestArea = area;
    }
  }
  return best;
}

function rangesOverlapInclusive(
  leftStart: number,
  leftEnd: number,
  rightStart: number,
  rightEnd: number,
): boolean {
  return Math.max(leftStart, rightStart) <= Math.min(leftEnd, rightEnd);
}
