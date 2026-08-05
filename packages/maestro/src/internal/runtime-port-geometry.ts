import { AppError } from '@agent-device/kernel/errors';
import { buildInPageSwipeGesturePlan } from '@agent-device/contracts/interaction';
import { isPositiveFiniteRect } from '@agent-device/kernel/rect';
import type { Rect, SnapshotState } from '@agent-device/kernel/snapshot';
import { pointInsideRect } from './shared.ts';
import {
  findNearestScrollableAncestor,
  isScrollableNodeLike,
  isViewportRootNode,
} from '@agent-device/contracts/snapshot';
import { MAESTRO_COMPATIBILITY_PRESETS } from './compatibility-policy.ts';
import { resolveNumeric } from './engine-flow.ts';
import type { MaestroRuntimeRequest } from './engine-types.ts';
import type {
  MaestroCoordinate,
  MaestroDirection,
  MaestroSelector,
  MaestroSwipeGesture,
} from './program-ir.ts';
import { operationContext } from './runtime-port-context.ts';
import { resolveMaestroTarget } from './runtime-port-observation.ts';
import {
  filterVisibleMaestroMatches,
  matchesMaestroTypedSelector,
  type MaestroPlatform,
} from './runtime-target-policy.ts';
import type {
  MaestroRuntimeOperations,
  MaestroSinglePointerGestureInput,
  MaestroSwipeOperation,
  MaestroTargetResolution,
} from './runtime-port-types.ts';

/**
 * Builds a Maestro-compatible scroll gesture inside a visible scrollable
 * viewport. Prefer the nearest eligible scrollable ancestor of a matching
 * target; otherwise use the largest eligible visible container. This avoids
 * beginning a screen-centred swipe in an unrelated nested gesture surface.
 */
export function resolveMaestroScrollableGesture(
  snapshot: SnapshotState,
  selector: MaestroSelector,
  direction: MaestroDirection,
  durationMs: number,
  platform: MaestroPlatform,
): { gesture: MaestroSinglePointerGestureInput; viewport: Rect } | undefined {
  const viewport = selectMaestroScrollableViewport(snapshot, selector, direction, platform);
  if (!viewport) return undefined;
  const { start, end } = maestroScrollUntilVisibleEndpoints(viewport, direction);
  return {
    gesture: {
      from: start,
      to: end,
      durationMs,
    },
    viewport,
  };
}

function selectMaestroScrollableViewport(
  snapshot: SnapshotState,
  selector: MaestroSelector,
  direction: MaestroDirection,
  platform: MaestroPlatform,
): Rect | undefined {
  const vertical = direction === 'up' || direction === 'down';
  const scrollable = filterVisibleMaestroMatches({
    nodes: snapshot.nodes,
    matches: snapshot.nodes.filter((node) => isScrollableNodeLike(node)),
    platform,
  });
  const applicationViewport =
    findLargestViewportRect(snapshot.nodes) ?? findLargestPositiveRect(scrollable);
  if (!applicationViewport || !isPositiveFiniteRect(applicationViewport)) return undefined;
  const candidates = scrollable.flatMap((node) => {
    if (!isPositiveFiniteRect(node.rect)) return [];
    const viewport = intersectRects(node.rect, applicationViewport);
    if (
      !viewport ||
      (vertical ? viewport.height <= viewport.width : viewport.width < viewport.height)
    ) {
      return [];
    }
    return [{ node, viewport }];
  });
  const byIndex = new Map(snapshot.nodes.map((node) => [node.index, node]));
  const candidateByIndex = new Map(
    candidates.map((candidate) => [candidate.node.index, candidate]),
  );
  for (const target of snapshot.nodes.filter((node) =>
    matchesMaestroTypedSelector(node, selector),
  )) {
    const container = findScrollContainer(target, byIndex);
    const candidate = container ? candidateByIndex.get(container.index) : undefined;
    if (candidate) return candidate.viewport;
  }
  return candidates.sort(compareViewportAreaDescending)[0]?.viewport;
}

/** The nearest scroll container at or above `node`. */
function findScrollContainer(
  node: SnapshotState['nodes'][number],
  byIndex: ReadonlyMap<number, SnapshotState['nodes'][number]>,
): SnapshotState['nodes'][number] | null {
  return isScrollableNodeLike(node) ? node : findNearestScrollableAncestor(node, byIndex);
}

function findLargestViewportRect(nodes: SnapshotState['nodes']): Rect | undefined {
  return nodes
    .filter((node) => {
      return isPositiveFiniteRect(node.rect) && isViewportRootNode(node);
    })
    .sort(
      (left, right) =>
        right.rect!.width * right.rect!.height - left.rect!.width * left.rect!.height,
    )[0]?.rect;
}

function findLargestPositiveRect(
  nodes: readonly SnapshotState['nodes'][number][],
): Rect | undefined {
  let largest: Rect | undefined;
  for (const node of nodes) {
    if (
      isPositiveFiniteRect(node.rect) &&
      (!largest || node.rect.width * node.rect.height > largest.width * largest.height)
    ) {
      largest = node.rect;
    }
  }
  return largest;
}

function intersectRects(left: Rect, right: Rect): Rect | undefined {
  const x = Math.max(left.x, right.x);
  const y = Math.max(left.y, right.y);
  const width = Math.min(left.x + left.width, right.x + right.width) - x;
  const height = Math.min(left.y + left.height, right.y + right.height) - y;
  return width > 0 && height > 0 ? { x, y, width, height } : undefined;
}

function compareViewportAreaDescending(
  left: { readonly viewport: Rect },
  right: { readonly viewport: Rect },
): number {
  return right.viewport.width * right.viewport.height - left.viewport.width * left.viewport.height;
}

function maestroScrollUntilVisibleEndpoints(
  viewport: Rect,
  direction: MaestroDirection,
): { start: { x: number; y: number }; end: { x: number; y: number } } {
  // Maestro 2.5.1 Orchestra converts ScrollDirection to the opposite
  // SwipeDirection, then calls Maestro.swipeFromCenter. The iOS and Android
  // drivers start at that center and end at 10% or 90% of the active axis. For
  // a screen-sized viewport this is the exact upstream gesture. A selected
  // scroll container keeps the same semantics while ensuring the origin belongs
  // to the scroll target.
  const center = pointInViewport(viewport, 0.5, 0.5);
  const near = MAESTRO_COMPATIBILITY_PRESETS.scrollUntilVisibleSwipe.nearEdgeFraction;
  const far = MAESTRO_COMPATIBILITY_PRESETS.scrollUntilVisibleSwipe.farEdgeFraction;
  switch (direction) {
    case 'up':
      return { start: center, end: pointInViewport(viewport, 0.5, far) };
    case 'down':
      return { start: center, end: pointInViewport(viewport, 0.5, near) };
    case 'left':
      return { start: center, end: pointInViewport(viewport, far, 0.5) };
    case 'right':
      return { start: center, end: pointInViewport(viewport, near, 0.5) };
  }
}

export async function resolveMaestroSwipeOperation(
  authored: MaestroSwipeGesture,
  request: MaestroRuntimeRequest,
  operations: MaestroRuntimeOperations,
): Promise<MaestroSwipeOperation> {
  const duration = resolveNumeric(authored.duration, 'swipe.duration');
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
      gesture: swipeFromEndpoints(start, end, duration),
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
      gesture: swipeFromEndpoints(start, end, duration),
      viewport,
    };
  }

  const target = await resolveMaestroTarget(
    authored.from,
    {
      purpose: 'swipe',
      timeoutMs:
        'optional' in request.command && request.command.optional === true
          ? MAESTRO_COMPATIBILITY_PRESETS.command.optionalTargetLookupTimeoutMs
          : MAESTRO_COMPATIBILITY_PRESETS.command.targetLookupTimeoutMs,
    },
    request,
    operations,
  );
  const viewport =
    target.viewport ??
    (await operations.resolveGestureViewport(operationContext(request, request.command)));
  const { start, end } = targetSwipeEndpoints(target, authored.direction, viewport);
  return {
    authored,
    gesture: swipeFromEndpoints(start, end, duration),
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
    x: viewport.x + Math.trunc((viewport.width * coordinate.x) / 100),
    y: viewport.y + Math.trunc((viewport.height * coordinate.y) / 100),
  };
}

function swipeFromEndpoints(
  start: { x: number; y: number },
  end: { x: number; y: number },
  durationMs: number | undefined,
): MaestroSinglePointerGestureInput {
  return {
    from: start,
    to: end,
    durationMs: durationMs ?? MAESTRO_COMPATIBILITY_PRESETS.command.swipeDurationMs,
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
  platform: MaestroRuntimeOperations['platform'],
): { start: { x: number; y: number }; end: { x: number; y: number } } {
  if (direction === 'left' || direction === 'right') {
    const plan = buildInPageSwipeGesturePlan(direction, {
      referenceWidth: viewport.width,
      referenceHeight: viewport.height,
    });
    return {
      start: { x: viewport.x + plan.x1, y: viewport.y + plan.y1 },
      end: { x: viewport.x + plan.x2, y: viewport.y + plan.y2 },
    };
  }
  const preset = MAESTRO_COMPATIBILITY_PRESETS.screenSwipe;
  const nearY = pointInViewport(viewport, preset.centerFraction, preset.nearEdgeFraction);
  const farY = pointInViewport(viewport, preset.centerFraction, preset.farEdgeFraction);
  const downStart = pointInViewport(viewport, preset.centerFraction, preset.downStartFraction);
  const upStart = pointInViewport(
    viewport,
    preset.centerFraction,
    preset.upStartFraction[platform],
  );
  return direction === 'up' ? { start: upStart, end: nearY } : { start: downStart, end: farY };
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
