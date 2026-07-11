import { clampToRange } from '../../contracts/scroll-gesture.ts';
import { pointInsideRect } from '../../utils/rect-center.ts';
import type { MaestroSnapshotTarget } from './runtime-targets.ts';

const MAESTRO_GEOMETRY_POLICY = {
  swipe: {
    screenRatio: 0.35,
    minDistancePx: 120,
    maxDistancePx: 360,
    marginPx: 8,
  },
} as const;

export function swipeCoordinatesFromTarget(
  target: MaestroSnapshotTarget,
  direction: string,
):
  | { ok: true; start: { x: number; y: number }; end: { x: number; y: number } }
  | { ok: false; message: string } {
  const center = pointInsideRect(target.rect);
  const frame = target.frame;
  const horizontalDistance = swipeDistance(frame?.referenceWidth, target.rect.width);
  const verticalDistance = swipeDistance(frame?.referenceHeight, target.rect.height);
  const margin = MAESTRO_GEOMETRY_POLICY.swipe.marginPx;
  const minX = margin;
  const minY = margin;
  const maxX = frame ? frame.referenceWidth - margin : center.x + horizontalDistance;
  const maxY = frame ? frame.referenceHeight - margin : center.y + verticalDistance;
  switch (direction.toLowerCase()) {
    case 'up':
      return {
        ok: true,
        start: center,
        end: {
          x: center.x,
          y: clampToRange(center.y - verticalDistance, minY, maxY),
        },
      };
    case 'down':
      return {
        ok: true,
        start: center,
        end: {
          x: center.x,
          y: clampToRange(center.y + verticalDistance, minY, maxY),
        },
      };
    case 'left':
      return {
        ok: true,
        start: center,
        end: {
          x: clampToRange(center.x - horizontalDistance, minX, maxX),
          y: center.y,
        },
      };
    case 'right':
      return {
        ok: true,
        start: center,
        end: {
          x: clampToRange(center.x + horizontalDistance, minX, maxX),
          y: center.y,
        },
      };
    default:
      return { ok: false, message: 'swipe.label direction must be up, down, left, or right.' };
  }
}

export function pointForMaestroTapOnTarget(target: MaestroSnapshotTarget): {
  x: number;
  y: number;
} {
  return pointInsideRect(target.rect);
}

function swipeDistance(frameSize: number | undefined, rectSize: number): number {
  const screenRelative =
    typeof frameSize === 'number' ? frameSize * MAESTRO_GEOMETRY_POLICY.swipe.screenRatio : 0;
  return Math.round(
    Math.min(
      MAESTRO_GEOMETRY_POLICY.swipe.maxDistancePx,
      Math.max(MAESTRO_GEOMETRY_POLICY.swipe.minDistancePx, screenRelative, rectSize * 1.5),
    ),
  );
}
