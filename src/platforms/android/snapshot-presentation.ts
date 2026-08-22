import type { RawSnapshotNode, Rect } from '@agent-device/kernel/snapshot';
import { isPositiveFiniteRect } from '@agent-device/kernel/rect';

/**
 * The typed carrier between Android acquisition facts and regular snapshot wire projection.
 *
 * `raw.rect` remains the helper-reported frame for raw output and traversal. `effectiveRect` is
 * the frame after the Android presentation clip fold. Keeping both values in one object prevents
 * a downstream consumer from accidentally publishing acquisition geometry for a regular node.
 */
export type AndroidSnapshotPresentationNode = {
  raw: RawSnapshotNode;
  effectiveRect?: Rect;
};

export function createAndroidSnapshotPresentationNode(
  raw: RawSnapshotNode,
  effectiveRect?: Rect,
): AndroidSnapshotPresentationNode {
  return { raw, ...(effectiveRect ? { effectiveRect } : {}) };
}

/**
 * Serializes the regular projection. The reported rectangle never crosses this boundary, and an
 * actionability claim is retained only when the effective geometry has positive area.
 */
export function serializeAndroidRegularPresentationNode(
  node: AndroidSnapshotPresentationNode,
): RawSnapshotNode {
  return {
    ...node.raw,
    ...(node.effectiveRect ? { rect: node.effectiveRect } : { rect: undefined }),
    hittable:
      node.raw.hittable === true && isPositiveFiniteRect(node.effectiveRect) ? true : undefined,
  };
}

/**
 * Folds the Android viewport and the nearest effective scroll clip into one cumulative clip.
 * Empty intersections keep the reported origin and become zero-area frames, matching the Swift
 * presentation geometry contract and keeping diagnostic coordinates useful.
 */
export function effectiveAndroidRect(
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
