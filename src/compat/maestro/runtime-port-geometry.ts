import { AppError } from '../../kernel/errors.ts';
import { normalizePublicSwipeMotion } from '../../contracts/gesture-normalization.ts';
import { pointInsideRect } from '../../utils/rect-center.ts';
import { MAESTRO_COMPATIBILITY_PRESETS } from './compatibility-policy.ts';
import type { MaestroRuntimeRequest } from './engine-types.ts';
import type { MaestroCoordinate, MaestroDirection, MaestroSwipeGesture } from './program-ir.ts';
import { operationContext } from './runtime-port-context.ts';
import { resolveMaestroTarget } from './runtime-port-observation.ts';
import type {
  MaestroRuntimeOperations,
  MaestroSinglePointerGestureInput,
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
    const viewport = await operations.resolveGestureViewport(
      operationContext(request, request.command),
    );
    const { start, end } = screenSwipeEndpoints(viewport, authored.direction, operations.platform);
    return {
      authored,
      gesture: normalizedSwipeFromEndpoints(start, end, authored.duration),
      viewport,
    };
  }

  const target = await resolveMaestroTarget(
    authored.from,
    {
      purpose: 'swipe',
      timeoutMs: MAESTRO_COMPATIBILITY_PRESETS.command.targetLookupTimeoutMs,
    },
    request,
    operations,
  );
  const viewport =
    target.viewport ??
    (await operations.resolveGestureViewport(operationContext(request, request.command)));
  const { start, end } = targetSwipeEndpoints(
    target,
    authored.direction ?? MAESTRO_COMPATIBILITY_PRESETS.targetSwipe.defaultDirection,
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
): MaestroSinglePointerGestureInput {
  const gesture = normalizePublicSwipeMotion({
    from: start,
    to: end,
    durationMs: durationMs ?? MAESTRO_COMPATIBILITY_PRESETS.command.swipeDurationMs,
  }).gesture;
  if (gesture.intent === 'pan' && 'origin' in gesture) {
    return {
      intent: 'pan',
      origin: gesture.origin,
      delta: gesture.delta,
      durationMs: gesture.durationMs,
      executionProfile: 'endpoint-hold',
    };
  }
  throw new AppError('COMMAND_FAILED', 'Swipe normalization produced a non-swipe gesture.');
}

function screenSwipeEndpoints(
  viewport: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  },
  direction: MaestroDirection,
  platform: MaestroRuntimeOperations['platform'],
): { start: { x: number; y: number }; end: { x: number; y: number } } {
  const preset = MAESTRO_COMPATIBILITY_PRESETS.screenSwipe;
  const nearX = pointInViewport(viewport, preset.nearEdgeFraction, preset.centerFraction);
  const farX = pointInViewport(viewport, preset.farEdgeFraction, preset.centerFraction);
  const nearY = pointInViewport(viewport, preset.centerFraction, preset.nearEdgeFraction);
  const farY = pointInViewport(viewport, preset.centerFraction, preset.farEdgeFraction);
  const downStart = pointInViewport(viewport, preset.centerFraction, preset.downStartFraction);
  const upStart = pointInViewport(
    viewport,
    preset.centerFraction,
    preset.upStartFraction[platform],
  );
  switch (direction) {
    case 'up':
      return { start: upStart, end: nearY };
    case 'down':
      return { start: downStart, end: farY };
    case 'left':
      return { start: farX, end: nearX };
    case 'right':
      return { start: nearX, end: farX };
  }
}

function pointInViewport(
  viewport: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  },
  xFraction: number,
  yFraction: number,
): { x: number; y: number } {
  return {
    x: viewport.x + Math.trunc(viewport.width * xFraction),
    y: viewport.y + Math.trunc(viewport.height * yFraction),
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
  const nearX =
    viewport.x +
    Math.trunc(viewport.width * MAESTRO_COMPATIBILITY_PRESETS.targetSwipe.nearEdgeFraction);
  const nearY =
    viewport.y +
    Math.trunc(viewport.height * MAESTRO_COMPATIBILITY_PRESETS.targetSwipe.nearEdgeFraction);
  const farX =
    viewport.x +
    Math.trunc(viewport.width * MAESTRO_COMPATIBILITY_PRESETS.targetSwipe.farEdgeFraction);
  const farY =
    viewport.y +
    Math.trunc(viewport.height * MAESTRO_COMPATIBILITY_PRESETS.targetSwipe.farEdgeFraction);
  switch (direction) {
    case 'up':
      return { start, end: { x: start.x, y: nearY } };
    case 'down':
      return { start, end: { x: start.x, y: farY } };
    case 'left':
      return { start, end: { x: nearX, y: start.y } };
    case 'right':
      return { start, end: { x: farX, y: start.y } };
  }
}
