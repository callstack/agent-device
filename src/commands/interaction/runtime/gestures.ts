import { AppError } from '../../../kernel/errors.ts';
import type { Point, Rect, SnapshotNode, SnapshotState } from '../../../kernel/snapshot.ts';
import { centerOfRect } from '../../../kernel/snapshot.ts';
import {
  buildSwipePresetGesturePlan,
  parseSwipePreset,
  type GestureReferenceFrame,
  type ScrollDirection,
  type SwipePreset,
} from '../../../core/scroll-gesture.ts';
import {
  assertExclusiveScrollDistanceInputs,
  honoredScrollDurationMs,
  normalizeScrollDurationMs,
} from '../../../core/scroll-command.ts';
import type { AgentDeviceRuntime, CommandContext } from '../../../runtime-contract.ts';
import { requireIntInRange } from '../../../utils/validation.ts';
import { successText } from '../../../utils/success-text.ts';
import { isNodeVisibleInEffectiveViewport } from '../../../snapshot/mobile-snapshot-semantics.ts';
import {
  captureScrollEdgeState,
  formatScrollEdgeMessage,
  runScrollEdgePasses,
  type ScrollEdge,
  type ScrollEdgeState,
  type ScrollEdgeTarget,
} from '../../../utils/scroll-edge-state.ts';
import { toBackendContext } from '../../runtime-common.ts';
import {
  toBackendResult,
  type BackendResultEnvelope,
  type BackendResultVariant,
  type RuntimeCommand,
} from '../../runtime-types.ts';
import type { LongPressCommandResult } from '../../../contracts/interaction.ts';
import {
  assertSupportedInteractionSurface,
  captureInteractionSnapshot,
  type InteractionTarget,
  type ResolvedInteractionTarget,
  resolveInteractionTarget,
} from './resolution.ts';

export type FocusCommandOptions = CommandContext & {
  target: InteractionTarget;
};

export type FocusCommandResult = ResolvedInteractionTarget & BackendResultEnvelope;

export type LongPressCommandOptions = CommandContext & {
  target: InteractionTarget;
  durationMs?: number;
};

export type { LongPressCommandResult };

export type GestureDirection = ScrollDirection;
export const SCROLL_INPUT_DIRECTIONS = ['up', 'down', 'left', 'right', 'top', 'bottom'] as const;
export type ScrollInputDirection = (typeof SCROLL_INPUT_DIRECTIONS)[number];

export type ScrollTarget =
  | InteractionTarget
  | {
      kind: 'viewport';
    };

export type ScrollCommandOptions = CommandContext & {
  target?: ScrollTarget;
  direction: ScrollInputDirection;
  amount?: number;
  pixels?: number;
  durationMs?: number;
};

export type ScrollCommandResult =
  | BackendResultVariant<{
      kind: 'viewport';
      direction: GestureDirection;
      edge?: 'top' | 'bottom';
      passes?: number;
      amount?: number;
      pixels?: number;
      durationMs?: number;
    }>
  | BackendResultVariant<
      ResolvedInteractionTarget & {
        direction: GestureDirection;
        edge?: 'top' | 'bottom';
        passes?: number;
        amount?: number;
        pixels?: number;
        durationMs?: number;
      }
    >;

type ResolvedScrollTarget = { kind: 'viewport' } | ResolvedInteractionTarget;

export type SwipeOptions = {
  from?: Point | InteractionTarget;
  to?: Point;
  direction?: GestureDirection;
  preset?: SwipePreset;
  distance?: number;
  durationMs?: number;
};

export type SwipeCommandOptions = CommandContext & SwipeOptions;

export type SwipeCommandResult = {
  kind: 'swipe';
  from: Point;
  to: Point;
  direction?: GestureDirection;
  preset?: SwipePreset;
  distance?: number;
  durationMs?: number;
  fromTarget?: ResolvedInteractionTarget | { kind: 'viewport' };
} & BackendResultEnvelope;

export type PinchCommandOptions = CommandContext & {
  scale: number;
  center?: InteractionTarget;
};

export type PinchCommandResult = {
  kind: 'pinch';
  scale: number;
  center?: Point;
  centerTarget?: ResolvedInteractionTarget;
} & BackendResultEnvelope;

export const focusCommand: RuntimeCommand<FocusCommandOptions, FocusCommandResult> = async (
  runtime,
  options,
): Promise<FocusCommandResult> => {
  const resolved = await resolveInteractionTarget(runtime, options, {
    action: 'focus',
    requireInteractive: true,
    promoteToHittableAncestor: false,
  });
  if (!runtime.backend.focus) {
    throw new AppError('UNSUPPORTED_OPERATION', 'focus is not supported by this backend');
  }
  const point = requireResolvedPoint(resolved);
  const backendResult = await runtime.backend.focus(toBackendContext(runtime, options), point);
  const formattedBackendResult = toBackendResult(backendResult);
  return {
    ...resolved,
    ...(formattedBackendResult ? { backendResult: formattedBackendResult } : {}),
    ...successText(`Focused (${point.x}, ${point.y})`),
  };
};

export const longPressCommand: RuntimeCommand<
  LongPressCommandOptions,
  LongPressCommandResult
> = async (runtime, options): Promise<LongPressCommandResult> => {
  const resolved = await resolveInteractionTarget(runtime, options, {
    action: 'longPress',
    requireInteractive: true,
    promoteToHittableAncestor: true,
  });
  if (!runtime.backend.longPress) {
    throw new AppError('UNSUPPORTED_OPERATION', 'longPress is not supported by this backend');
  }
  const durationMs =
    options.durationMs === undefined
      ? undefined
      : requireIntInRange(options.durationMs, 'durationMs', 0, 120_000);
  const point = requireResolvedPoint(resolved);
  const backendResult = await runtime.backend.longPress(toBackendContext(runtime, options), point, {
    durationMs,
  });
  const formattedBackendResult = toBackendResult(backendResult);
  return {
    ...resolved,
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(formattedBackendResult ? { backendResult: formattedBackendResult } : {}),
    ...successText(`Long pressed (${point.x}, ${point.y})`),
  };
};

export const scrollCommand: RuntimeCommand<ScrollCommandOptions, ScrollCommandResult> = async (
  runtime,
  options,
): Promise<ScrollCommandResult> => {
  if (!runtime.backend.scroll) {
    throw new AppError('UNSUPPORTED_OPERATION', 'scroll is not supported by this backend');
  }
  const target = resolveScrollDirection(options.direction);
  const amount = normalizeOptionalPositiveNumber(options.amount, 'scroll amount');
  const pixels = normalizeOptionalPositiveInteger(options.pixels, 'scroll pixels');
  const durationMs = normalizeScrollDurationMs(options.durationMs);
  assertExclusiveScrollDistanceInputs(
    { amount, pixels },
    'scroll accepts either amount or pixels, not both',
  );

  const resolved = await resolveScrollTarget(runtime, options);
  const backendTarget =
    resolved.kind === 'viewport'
      ? { kind: 'viewport' as const }
      : { kind: 'point' as const, point: requireResolvedPoint(resolved) };
  const scrollBackend = runtime.backend.scroll;
  const runScroll = async () =>
    await scrollBackend(toBackendContext(runtime, options), backendTarget, {
      direction: target.direction,
      ...(amount !== undefined ? { amount } : {}),
      ...(pixels !== undefined ? { pixels } : {}),
      ...(durationMs !== undefined ? { durationMs } : {}),
    });
  let backendResult: Awaited<ReturnType<NonNullable<typeof runtime.backend.scroll>>> | undefined;
  let completedPasses = 0;
  if (target.edge) {
    const edge = target.edge;
    const edgeTarget = buildScrollEdgeTarget(resolved);
    const edgeResult = await runScrollEdgePasses({
      edge,
      captureState: async (scope) =>
        await captureRuntimeScrollEdgeState(runtime, options, edge, edgeTarget, scope),
      scroll: runScroll,
    });
    backendResult = edgeResult.result;
    completedPasses = edgeResult.passes;
  } else {
    backendResult = await runScroll();
    completedPasses = 1;
  }
  const formattedBackendResult = toBackendResult(backendResult);
  const reportedDurationMs = honoredScrollDurationMs(formattedBackendResult);
  return {
    ...resolved,
    direction: target.direction,
    ...(target.edge ? { edge: target.edge, passes: completedPasses } : {}),
    ...(amount !== undefined ? { amount } : {}),
    ...(pixels !== undefined ? { pixels } : {}),
    ...(reportedDurationMs !== undefined ? { durationMs: reportedDurationMs } : {}),
    ...(formattedBackendResult ? { backendResult: formattedBackendResult } : {}),
    ...successText(
      formatScrollEdgeMessage(target.direction, target.edge, completedPasses, amount, pixels),
    ),
  };
};

export const swipeCommand: RuntimeCommand<SwipeCommandOptions, SwipeCommandResult> = async (
  runtime,
  options,
): Promise<SwipeCommandResult> => {
  if (!runtime.backend.swipe) {
    throw new AppError('UNSUPPORTED_OPERATION', 'swipe is not supported by this backend');
  }
  if (options.preset) {
    return await runSwipePreset(runtime, options, runtime.backend.swipe);
  }
  const resolvedFrom = await resolveSwipeFrom(runtime, options);
  const to = resolveSwipeTo(resolvedFrom.point, options);
  const durationMs =
    options.durationMs === undefined
      ? undefined
      : requireIntInRange(options.durationMs, 'durationMs', 16, 10_000);
  const backendResult = await runtime.backend.swipe(
    toBackendContext(runtime, options),
    resolvedFrom.point,
    to.point,
    { durationMs },
  );
  const formattedBackendResult = toBackendResult(backendResult);
  return {
    kind: 'swipe',
    from: resolvedFrom.point,
    to: to.point,
    ...(to.direction ? { direction: to.direction } : {}),
    ...(to.distance !== undefined ? { distance: to.distance } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(resolvedFrom.target ? { fromTarget: resolvedFrom.target } : {}),
    ...(formattedBackendResult ? { backendResult: formattedBackendResult } : {}),
    ...successText('Swiped'),
  };
};

async function runSwipePreset(
  runtime: AgentDeviceRuntime,
  options: SwipeCommandOptions,
  swipeBackend: NonNullable<AgentDeviceRuntime['backend']['swipe']>,
): Promise<SwipeCommandResult> {
  if (options.from || options.to || options.direction || options.distance !== undefined) {
    throw new AppError(
      'INVALID_ARGS',
      'gesture swipe preset cannot be combined with from, to, direction, or distance',
    );
  }
  const preset = parseSwipePreset(options.preset);
  await assertSupportedInteractionSurface(runtime, options, 'swipe');
  const capture = await captureInteractionSnapshot(runtime, options, false);
  const frame = resolveSnapshotReferenceFrame(capture.snapshot.nodes);
  const plan = buildSwipePresetGesturePlan(preset, frame, { platform: runtime.backend.platform });
  const durationMs =
    options.durationMs === undefined
      ? undefined
      : requireIntInRange(options.durationMs, 'durationMs', 16, 10_000);
  const from = { x: plan.x1, y: plan.y1 };
  const to = { x: plan.x2, y: plan.y2 };
  const backendResult = await swipeBackend(toBackendContext(runtime, options), from, to, {
    durationMs,
  });
  const formattedBackendResult = toBackendResult(backendResult);
  return {
    kind: 'swipe',
    from,
    to,
    preset,
    ...(durationMs !== undefined ? { durationMs } : {}),
    fromTarget: { kind: 'viewport' },
    ...(formattedBackendResult ? { backendResult: formattedBackendResult } : {}),
    ...successText(`Swiped ${preset}`),
  };
}

export const pinchCommand: RuntimeCommand<PinchCommandOptions, PinchCommandResult> = async (
  runtime,
  options,
): Promise<PinchCommandResult> => {
  if (!runtime.backend.pinch) {
    throw new AppError('UNSUPPORTED_OPERATION', 'pinch is not supported by this backend');
  }
  await assertSupportedInteractionSurface(runtime, options, 'pinch');
  const scale = normalizePositiveNumber(options.scale, 'pinch scale');
  const centerTarget = options.center
    ? await resolveInteractionTarget(
        runtime,
        { ...options, target: options.center },
        {
          action: 'pinch',
          requireInteractive: false,
          promoteToHittableAncestor: false,
        },
      )
    : undefined;
  const backendResult = await runtime.backend.pinch(toBackendContext(runtime, options), {
    scale,
    ...(centerTarget ? { center: centerTarget.point } : {}),
  });
  const formattedBackendResult = toBackendResult(backendResult);
  return {
    kind: 'pinch',
    scale,
    ...(centerTarget ? { center: centerTarget.point, centerTarget } : {}),
    ...(formattedBackendResult ? { backendResult: formattedBackendResult } : {}),
    ...successText(`Pinched to scale ${scale}`),
  };
};

async function resolveScrollTarget(
  runtime: AgentDeviceRuntime,
  options: ScrollCommandOptions,
): Promise<ResolvedScrollTarget> {
  const target = options.target ?? { kind: 'viewport' as const };
  if (target.kind === 'viewport') {
    await assertSupportedInteractionSurface(runtime, options, 'scroll');
    return { kind: 'viewport' };
  }
  return await resolveInteractionTarget(
    runtime,
    { ...options, target },
    {
      action: 'scroll',
      requireInteractive: false,
      promoteToHittableAncestor: false,
    },
  );
}

async function resolveSwipeFrom(
  runtime: AgentDeviceRuntime,
  options: SwipeCommandOptions,
): Promise<{
  point: Point;
  target?: ResolvedInteractionTarget | { kind: 'viewport' };
}> {
  if (options.from) {
    if (isPointLike(options.from)) {
      await assertSupportedInteractionSurface(runtime, options, 'swipe');
      return { point: requirePoint(options.from, 'from') };
    }
    const target = await resolveInteractionTarget(
      runtime,
      { ...options, target: options.from },
      {
        action: 'swipe',
        requireInteractive: false,
        promoteToHittableAncestor: false,
      },
    );
    return { point: requireResolvedPoint(target), target };
  }
  if (!options.direction) {
    throw new AppError('INVALID_ARGS', 'swipe requires from+to or a direction');
  }
  await assertSupportedInteractionSurface(runtime, options, 'swipe');
  const capture = await captureInteractionSnapshot(runtime, options, false);
  const viewport = resolveSnapshotViewport(capture.snapshot.nodes);
  return {
    point: centerOfRect(viewport),
    target: { kind: 'viewport' },
  };
}

function resolveSwipeTo(
  from: Point,
  options: SwipeCommandOptions,
): { point: Point; direction?: GestureDirection; distance?: number } {
  if (options.to) return { point: requirePoint(options.to, 'to') };
  const direction = requireDirection(options.direction, 'swipe direction');
  const distance = normalizePositiveNumber(options.distance ?? 200, 'swipe distance');
  switch (direction) {
    case 'up':
      return { point: { x: from.x, y: from.y - distance }, direction, distance };
    case 'down':
      return { point: { x: from.x, y: from.y + distance }, direction, distance };
    case 'left':
      return { point: { x: from.x - distance, y: from.y }, direction, distance };
    case 'right':
      return { point: { x: from.x + distance, y: from.y }, direction, distance };
  }
}

function resolveScrollDirection(direction: ScrollInputDirection): {
  direction: GestureDirection;
  edge?: 'top' | 'bottom';
} {
  if (direction === 'bottom') return { direction: 'down', edge: 'bottom' };
  if (direction === 'top') return { direction: 'up', edge: 'top' };
  return { direction: requireDirection(direction, 'scroll direction') };
}

function buildScrollEdgeTarget(resolved: ResolvedScrollTarget): ScrollEdgeTarget {
  return resolved.kind === 'viewport'
    ? {}
    : {
        point: resolved.point,
        nodeIndex: 'node' in resolved ? resolved.node?.index : undefined,
      };
}

function requireResolvedPoint(result: { point?: Point }): Point {
  if (!result.point) {
    throw new AppError('COMMAND_FAILED', 'Interaction target resolved without coordinates');
  }
  return result.point;
}

async function captureRuntimeScrollEdgeState(
  runtime: AgentDeviceRuntime,
  options: ScrollCommandOptions,
  edge: ScrollEdge,
  target: ScrollEdgeTarget,
  scope?: string,
): Promise<ScrollEdgeState> {
  if (!runtime.backend.captureSnapshot) {
    throw new AppError(
      'UNSUPPORTED_OPERATION',
      `scroll ${edge} requires snapshot support to verify hidden content before scrolling`,
    );
  }
  const { captureSnapshot } = runtime.backend;
  return await captureScrollEdgeState({
    edge,
    target,
    scope,
    captureNodes: async (snapshotScope) => {
      const result = await captureSnapshot(toBackendContext(runtime, options), {
        scope: snapshotScope,
      });
      return result.snapshot?.nodes ?? result.nodes ?? [];
    },
  });
}

function requireDirection(
  direction: GestureDirection | undefined,
  field: string,
): GestureDirection {
  switch (direction) {
    case 'up':
    case 'down':
    case 'left':
    case 'right':
      return direction;
    default:
      throw new AppError('INVALID_ARGS', `${field} must be up, down, left, or right`);
  }
}

function requirePoint(point: Point, field: string): Point {
  const x = Number(point.x);
  const y = Number(point.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    throw new AppError('INVALID_ARGS', `${field} point requires finite x and y`);
  }
  return { x, y };
}

function isPointLike(value: Point | InteractionTarget): value is Point {
  return 'x' in value && 'y' in value;
}

function normalizeOptionalPositiveNumber(
  value: number | undefined,
  field: string,
): number | undefined {
  return value === undefined ? undefined : normalizePositiveNumber(value, field);
}

function normalizePositiveNumber(value: number, field: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new AppError('INVALID_ARGS', `${field} must be a positive number`);
  }
  return value;
}

function normalizeOptionalPositiveInteger(
  value: number | undefined,
  field: string,
): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
    throw new AppError('INVALID_ARGS', `${field} must be a positive integer`);
  }
  return value;
}

function resolveSnapshotViewport(nodes: SnapshotState['nodes']): Rect {
  const visibleRects = nodes
    .filter((node) => isNodeVisibleInEffectiveViewport(node, nodes))
    .map((node) => node.rect)
    .filter(isUsableRect);
  const rects =
    visibleRects.length > 0 ? visibleRects : nodes.map((node) => node.rect).filter(isUsableRect);
  if (rects.length === 0) {
    throw new AppError('COMMAND_FAILED', 'Cannot infer viewport for directional swipe');
  }
  const minX = Math.min(...rects.map((rect) => rect.x));
  const minY = Math.min(...rects.map((rect) => rect.y));
  const maxX = Math.max(...rects.map((rect) => rect.x + rect.width));
  const maxY = Math.max(...rects.map((rect) => rect.y + rect.height));
  return {
    x: minX,
    y: minY,
    width: maxX - minX,
    height: maxY - minY,
  };
}

function resolveSnapshotReferenceFrame(nodes: SnapshotState['nodes']): GestureReferenceFrame {
  const viewport = resolveSnapshotViewport(nodes);
  return {
    referenceWidth: viewport.width,
    referenceHeight: viewport.height,
  };
}

function isUsableRect(rect: SnapshotNode['rect']): rect is NonNullable<SnapshotNode['rect']> {
  return Boolean(rect && rect.width > 0 && rect.height > 0);
}
