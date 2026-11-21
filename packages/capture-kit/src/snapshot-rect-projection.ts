import { AppError } from '@agent-device/kernel/errors';
import { SCREENSHOT_CROP_REASONS } from '@agent-device/contracts/capture';
import {
  isMeaningfulSignal,
  isViewportRootNode,
  normalizeType,
} from '@agent-device/contracts/snapshot';
import { intersectRects, isPositiveFiniteRect, rectArea } from '@agent-device/kernel/rect';
import type { Rect, SnapshotCaptureScale, SnapshotNode } from '@agent-device/kernel/snapshot';

/**
 * The space a snapshot's rects are expressed in, as far as the captured image is concerned:
 * `device-pixels` rects land on the PNG at the producer's capture scale, 1:1 unless it published
 * one (Android; a TV app page's CSS px), `viewport-points` rects must be shifted by the viewport
 * bounds and scaled to the image (Apple, where 1x/2x/3x captures all share the points-space tree).
 */
export type ScreenshotRectSpace = 'device-pixels' | 'viewport-points';

/**
 * The single decision site for `screenshot --crop-on`: which projection law a snapshot backend's
 * rects obey. Backends the crop feature has not accepted project nothing, so an unaccepted
 * backend is a typed refusal, never a guess.
 */
export function resolveScreenshotRectSpace(backend: string | undefined): ScreenshotRectSpace {
  switch (backend) {
    case 'android':
      return 'device-pixels';
    case 'xctest':
    case 'macos-helper':
      return 'viewport-points';
    default:
      throw new AppError(
        'UNSUPPORTED_OPERATION',
        `screenshot --crop-on does not accept snapshot backend "${backend ?? 'unknown'}"`,
        { reason: SCREENSHOT_CROP_REASONS.targetNotAccepted.reason },
      );
  }
}

/**
 * Where a snapshot rect falls in the captured image: the space-specific law only, with NO
 * clamping. Callers decide what out-of-image means — the overlay clamps to a 1px box, the crop
 * intersects and refuses the empty case. `captureScale` is the producer's published scale, which
 * only `device-pixels` rects obey.
 */
export function projectSnapshotRectToScreenshot(
  space: ScreenshotRectSpace,
  bounds: Rect | null,
  rect: Rect,
  imageWidth: number,
  imageHeight: number,
  captureScale?: SnapshotCaptureScale,
): Rect {
  if (space === 'device-pixels') {
    const scale = captureScale ?? 1;
    return {
      x: Math.round(rect.x * scale),
      y: Math.round(rect.y * scale),
      width: Math.round(rect.width * scale),
      height: Math.round(rect.height * scale),
    };
  }
  if (bounds === null) return roundRect(rect);
  const scaleX = imageWidth / bounds.width;
  const scaleY = imageHeight / bounds.height;
  return {
    x: Math.round((rect.x - bounds.x) * scaleX),
    y: Math.round((rect.y - bounds.y) * scaleY),
    width: Math.round(rect.width * scaleX),
    height: Math.round(rect.height * scaleY),
  };
}

/**
 * The top-left part of the image a page fills when its producer published a capture scale: the
 * viewport at that scale. A webOS app at 1280x720 fills 1280x720 of a 1920x1080 capture, and the
 * rest is not the page. Without a capture scale the whole image is the frame.
 */
export function resolveScreenshotFrame(
  image: Readonly<{ width: number; height: number }>,
  page: Readonly<{
    viewport?: Readonly<{ width: number; height: number }>;
    captureScale?: SnapshotCaptureScale;
  }>,
): { width: number; height: number } {
  if (page.captureScale === undefined || page.viewport === undefined) {
    return { width: image.width, height: image.height };
  }
  return {
    width: Math.min(image.width, Math.round(page.viewport.width * page.captureScale)),
    height: Math.min(image.height, Math.round(page.viewport.height * page.captureScale)),
  };
}

/**
 * The crop box a projected rect actually yields: its intersection with the image frame. `null`
 * means the rect occupies no image pixel — a crop cannot be taken, not a 1px sliver.
 */
export function intersectScreenshotRect(
  rect: Rect,
  imageWidth: number,
  imageHeight: number,
): Rect | null {
  return intersectRects(rect, { x: 0, y: 0, width: imageWidth, height: imageHeight }) ?? null;
}

/**
 * The viewport the tree's points-space rects are measured against: the largest viewport root
 * with a positive rect, else the union of every rect-carrying node (unlabeled images excluded as
 * bounds outliers). One copy, shared by the ref overlay and the crop projection.
 */
export function resolveSnapshotBounds(
  nodes: ReadonlyArray<Pick<SnapshotNode, 'type' | 'label' | 'rect'>>,
): Rect | null {
  let viewport: Rect | null = null;
  for (const node of nodes) {
    if (!isViewportRootNode(node) || !isPositiveFiniteRect(node.rect)) continue;
    if (!viewport || rectArea(node.rect) > rectArea(viewport)) {
      viewport = node.rect;
    }
  }
  if (viewport) return viewport;

  return measureSnapshotBounds(
    nodes.filter((node) => isPositiveFiniteRect(node.rect) && !isSnapshotBoundsOutlier(node)),
  );
}

function measureSnapshotBounds(nodes: ReadonlyArray<Pick<SnapshotNode, 'rect'>>): Rect | null {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxRight = Number.NEGATIVE_INFINITY;
  let maxBottom = Number.NEGATIVE_INFINITY;
  for (const node of nodes) {
    if (!isPositiveFiniteRect(node.rect)) continue;
    minX = Math.min(minX, node.rect.x);
    minY = Math.min(minY, node.rect.y);
    maxRight = Math.max(maxRight, node.rect.x + node.rect.width);
    maxBottom = Math.max(maxBottom, node.rect.y + node.rect.height);
  }
  if (!Number.isFinite(minX) || !Number.isFinite(minY) || maxRight <= minX || maxBottom <= minY) {
    return null;
  }
  return {
    x: minX,
    y: minY,
    width: maxRight - minX,
    height: maxBottom - minY,
  };
}

function isSnapshotBoundsOutlier(node: Pick<SnapshotNode, 'type' | 'label'>): boolean {
  return normalizeType(node.type ?? '') === 'image' && !isMeaningfulSignal(node.label);
}

function roundRect(rect: Rect): Rect {
  return {
    x: Math.round(rect.x),
    y: Math.round(rect.y),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
  };
}
