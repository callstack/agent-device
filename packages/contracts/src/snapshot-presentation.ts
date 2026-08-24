import type { RawSnapshotNode, Rect } from '@agent-device/kernel/snapshot';
import { isPositiveFiniteRect } from '@agent-device/kernel/rect';

/**
 * The typed carrier between acquisition facts and a regular snapshot projection.
 *
 * `raw.rect` remains the backend-reported frame for raw output and traversal. A regular
 * projection must publish `effectiveRect`, after the owning presentation policy has folded its
 * viewport and ancestor clips. Keeping both values in one contract prevents an adapter from
 * accidentally publishing acquisition geometry as presented geometry (#1797, #1983).
 */
export type SnapshotPresentationNode = {
  raw: RawSnapshotNode;
  effectiveRect?: Rect;
};

export function createSnapshotPresentationNode(
  raw: RawSnapshotNode,
  effectiveRect?: Rect,
): SnapshotPresentationNode {
  return {
    raw,
    ...(effectiveRect ? { effectiveRect } : {}),
  };
}

/**
 * Folds a reported frame through the viewport and the nearest effective ancestor clip.
 * Empty intersections preserve the reported origin and become zero-area frames, so diagnostics
 * retain useful coordinates while regular actionability can fail closed.
 */
export function foldSnapshotRect(
  reportedRect: Rect | undefined,
  viewport: Rect | undefined,
  ancestorClip: Rect | undefined,
): Rect | undefined {
  if (!reportedRect) return undefined;
  let effective = normalizeRect(reportedRect);
  if (viewport) effective = intersectRect(effective, viewport);
  if (ancestorClip) effective = intersectRect(effective, ancestorClip);
  return effective;
}

/** Serializes one regular node without allowing its reported frame to cross the presentation seam. */
export function serializeRegularSnapshotPresentationNode(
  node: SnapshotPresentationNode,
): RawSnapshotNode {
  return {
    ...node.raw,
    ...(node.effectiveRect ? { rect: node.effectiveRect } : { rect: undefined }),
    hittable:
      node.raw.hittable === true && isPositiveFiniteRect(node.effectiveRect) ? true : undefined,
  };
}

function intersectRect(left: Rect, right: Rect): Rect {
  const x = Math.max(left.x, right.x);
  const y = Math.max(left.y, right.y);
  const maxX = Math.min(left.x + left.width, right.x + right.width);
  const maxY = Math.min(left.y + left.height, right.y + right.height);
  const hasIntersection = maxX > x && maxY > y;
  return {
    x: hasIntersection ? x : left.x,
    y: hasIntersection ? y : left.y,
    width: hasIntersection ? maxX - x : 0,
    height: hasIntersection ? maxY - y : 0,
  };
}

function normalizeRect(rect: Rect): Rect {
  return {
    x: rect.x,
    y: rect.y,
    width: Math.max(0, rect.width),
    height: Math.max(0, rect.height),
  };
}
