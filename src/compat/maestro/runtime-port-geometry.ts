import { AppError } from '../../kernel/errors.ts';
import {
  normalizePublicSwipeMotion,
  type NormalizedGestureInput,
} from '../../contracts/gesture-normalization.ts';
import { clampToRange } from '../../contracts/scroll-gesture.ts';
import { buildInPageSwipeGesturePlan } from '../../contracts/scroll-gesture.ts';
import { pointInsideRect } from '../../utils/rect-center.ts';
import type { MaestroRuntimeRequest } from './engine-types.ts';
import type { MaestroCoordinate, MaestroDirection, MaestroSwipeGesture } from './program-ir.ts';
import { operationContext } from './runtime-port-context.ts';
import { resolveMaestroTarget } from './runtime-port-observation.ts';
import { MAESTRO_TARGET_SWIPE_POLICY } from './runtime-port-geometry-policy.ts';
import type {
  MaestroRuntimeOperations,
  MaestroSwipeOperation,
  MaestroTargetResolution,
} from './runtime-port-types.ts';

export async function resolveMaestroSwipeOperation(
  authored: MaestroSwipeGesture,
  request: MaestroRuntimeRequest,
  operations: MaestroRuntimeOperations,
): Promise<MaestroSwipeOperation> {
  if (authored.kind === 'coordinates') {
    if (authored.start.space !== authored.end.space) {
      throw new AppError(
        'INVALID_ARGS',
        'Maestro swipe endpoints must use the same coordinate space.',
      );
    }
    const viewport =
      authored.start.space === 'percent'
        ? await operations.resolveGestureViewport(operationContext(request, request.command))
        : undefined;
    const start = await resolveMaestroCoordinate(authored.start, request, operations, viewport);
    const end = await resolveMaestroCoordinate(authored.end, request, operations, viewport);
    return {
      authored,
      gesture: normalizedSwipeFromEndpoints(start, end, authored.duration),
      ...(viewport ? { viewport } : {}),
    };
  }

  if (authored.kind === 'screen') {
    if (authored.direction === 'left' || authored.direction === 'right') {
      return {
        authored,
        gesture: normalizedScreenHorizontalSwipe(authored.direction, authored.duration),
      };
    }
    const viewport = await operations.resolveGestureViewport(
      operationContext(request, request.command),
    );
    const { start, end } = screenSwipeEndpoints(viewport, authored.direction);
    return {
      authored,
      gesture: normalizedScreenVerticalSwipe(authored.direction, start, end, authored.duration),
      viewport,
    };
  }

  const target = await resolveMaestroTarget(authored.from, {}, request, operations);
  const viewport =
    target.viewport ??
    (await operations.resolveGestureViewport(operationContext(request, request.command)));
  const { start, end } = targetSwipeEndpoints(
    target,
    authored.direction ?? MAESTRO_TARGET_SWIPE_POLICY.defaultDirection,
    viewport,
  );
  return {
    authored,
    gesture: normalizedSwipeFromEndpoints(start, end, authored.duration),
    target,
    viewport,
  };
}

export async function resolveMaestroCoordinate(
  coordinate: MaestroCoordinate,
  request: MaestroRuntimeRequest,
  operations: MaestroRuntimeOperations,
  knownViewport?: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  },
): Promise<{ x: number; y: number }> {
  if (coordinate.space === 'absolute') return { x: coordinate.x, y: coordinate.y };
  const viewport =
    knownViewport ??
    (await operations.resolveGestureViewport(operationContext(request, request.command)));
  return {
    x: Math.round(viewport.x + (viewport.width * coordinate.x) / 100),
    y: Math.round(viewport.y + (viewport.height * coordinate.y) / 100),
  };
}

function normalizedSwipeFromEndpoints(
  start: { x: number; y: number },
  end: { x: number; y: number },
  durationMs: number | undefined,
): NormalizedGestureInput {
  return normalizePublicSwipeMotion({ from: start, to: end, durationMs }).gesture;
}

function normalizedScreenHorizontalSwipe(
  direction: Extract<MaestroDirection, 'left' | 'right'>,
  durationMs: number | undefined,
): NormalizedGestureInput {
  const preset = direction;
  return durationMs === undefined
    ? { intent: 'fling', preset }
    : { intent: 'pan', preset, durationMs };
}

function normalizedScreenVerticalSwipe(
  direction: Extract<MaestroDirection, 'up' | 'down'>,
  start: { x: number; y: number },
  end: { x: number; y: number },
  durationMs: number | undefined,
): NormalizedGestureInput {
  if (durationMs !== undefined) return normalizedSwipeFromEndpoints(start, end, durationMs);
  return {
    intent: 'fling',
    direction,
    origin: start,
    distance: Math.abs(end.y - start.y),
  };
}

function screenSwipeEndpoints(
  viewport: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  },
  direction: MaestroDirection,
): { start: { x: number; y: number }; end: { x: number; y: number } } {
  const plan = buildInPageSwipeGesturePlan(direction, {
    referenceWidth: viewport.width,
    referenceHeight: viewport.height,
  });
  return {
    start: { x: viewport.x + plan.x1, y: viewport.y + plan.y1 },
    end: { x: viewport.x + plan.x2, y: viewport.y + plan.y2 },
  };
}

function targetSwipeEndpoints(
  target: MaestroTargetResolution,
  direction: MaestroDirection,
  viewport: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  },
): { start: { x: number; y: number }; end: { x: number; y: number } } {
  const start = pointInsideRect(target.rect);
  const horizontalDistance = swipeDistance(viewport.width, target.rect.width);
  const verticalDistance = swipeDistance(viewport.height, target.rect.height);
  const minX = viewport.x + MAESTRO_TARGET_SWIPE_POLICY.viewportMarginPx;
  const minY = viewport.y + MAESTRO_TARGET_SWIPE_POLICY.viewportMarginPx;
  const maxX = viewport.x + viewport.width - MAESTRO_TARGET_SWIPE_POLICY.viewportMarginPx;
  const maxY = viewport.y + viewport.height - MAESTRO_TARGET_SWIPE_POLICY.viewportMarginPx;
  switch (direction) {
    case 'up':
      return {
        start,
        end: { x: start.x, y: clampToRange(start.y - verticalDistance, minY, maxY) },
      };
    case 'down':
      return {
        start,
        end: { x: start.x, y: clampToRange(start.y + verticalDistance, minY, maxY) },
      };
    case 'left':
      return {
        start,
        end: { x: clampToRange(start.x - horizontalDistance, minX, maxX), y: start.y },
      };
    case 'right':
      return {
        start,
        end: { x: clampToRange(start.x + horizontalDistance, minX, maxX), y: start.y },
      };
  }
}

function swipeDistance(viewportSize: number, targetSize: number): number {
  const screenRelative = viewportSize * MAESTRO_TARGET_SWIPE_POLICY.screenTravelFraction;
  return Math.round(
    Math.min(
      MAESTRO_TARGET_SWIPE_POLICY.maxTravelPx,
      Math.max(
        MAESTRO_TARGET_SWIPE_POLICY.minTravelPx,
        screenRelative,
        targetSize * MAESTRO_TARGET_SWIPE_POLICY.targetTravelMultiplier,
      ),
    ),
  );
}
