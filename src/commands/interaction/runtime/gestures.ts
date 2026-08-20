import type {
  DragGestureInput,
  HoverCommandResult,
  LongPressCommandResult,
  ResolutionDisclosure,
  ScrollDirection,
  ScrollInputDirection,
} from '@agent-device/contracts/interaction';
import {
  assertExclusiveScrollDistanceInputs,
  buildDragGesturePlan,
  honoredScrollDurationMs,
  normalizeScrollDurationMs,
  resolveScrollExecutionOptions,
  singlePointerPlanEndpoints,
} from '@agent-device/contracts/interaction';
import { AppError } from '@agent-device/kernel/errors';
import { SELECTOR_PIPELINE_POLICIES } from '../../../core/selector-pipeline-policy.ts';
import type { Point, Rect, SnapshotNode } from '@agent-device/kernel/snapshot';
import type { AgentDeviceRuntime, CommandContext } from '../../../runtime-contract.ts';
import {
  captureScrollEdgeState,
  formatScrollEdgeMessage,
  runScrollEdgePasses,
  type ScrollEdge,
  type ScrollEdgeState,
  type ScrollEdgeTarget,
} from '../../../utils/scroll-edge-state.ts';
import { successText } from '../../../utils/success-text.ts';
import { requireIntInRange } from '../../../utils/validation.ts';
import { toBackendContext } from '../../runtime-common.ts';
import {
  toBackendResult,
  type BackendResultEnvelope,
  type BackendResultVariant,
  type RuntimeCommand,
} from '../../runtime-types.ts';
import {
  applyPostActionObservation,
  planPostActionObservation,
  type SettlePostActionObservationOptions,
} from './post-action-observation.ts';
import {
  assertSupportedInteractionSurface,
  captureInteractionSnapshot,
  dispatchNativeRefInteraction,
  resolveInteractionTarget,
  type ExpectedResolvedTarget,
  type InteractionTarget,
  type ResolvedInteractionTarget,
} from './resolution.ts';
import { resolveVisibleSnapshotViewport } from './viewport.ts';

type DragRecordingTarget = {
  selectorChain: string[];
  node: SnapshotNode;
  preActionNodes: SnapshotNode[];
};

type DragTargetDisclosure = {
  selectorChain?: string[];
  resolution: ResolutionDisclosure;
};

export type DragCommandOptions = CommandContext & {
  gesture: DragGestureInput;
  expectedResolvedTargets?: {
    source?: ExpectedResolvedTarget;
    destination?: ExpectedResolvedTarget;
  };
};

export type DragCommandResult = BackendResultEnvelope & {
  kind: 'drag';
  durationMs: number;
  pointerCount: 1;
  from: Point;
  to: Point;
  recording?: {
    sourceSelector?: string;
    destinationSelector?: string;
    sourceTarget?: DragRecordingTarget;
    destinationTarget?: DragRecordingTarget;
  };
  targets: {
    source: DragTargetDisclosure;
    destination: DragTargetDisclosure;
  };
};

/** Resolves the coordinate frame shared by coordinate- and target-authored gestures. */
export async function resolveGestureViewport(
  runtime: AgentDeviceRuntime,
  options: CommandContext,
): Promise<Rect> {
  const backendViewport = await runtime.backend.resolveGestureViewport?.(
    toBackendContext(runtime, options),
  );
  if (backendViewport) return backendViewport;
  const capture = await captureInteractionSnapshot(runtime, options, false);
  return resolveVisibleSnapshotViewport(capture.snapshot.nodes, 'gesture');
}

export type FocusCommandOptions = CommandContext & {
  target: InteractionTarget;
};

export type FocusCommandResult = ResolvedInteractionTarget & BackendResultEnvelope;

export type LongPressCommandOptions = CommandContext & {
  target: InteractionTarget;
  durationMs?: number;
  /** ADR 0012 step 4: replay-only post-resolution guard; see resolution.ts. */
  expectedResolvedTarget?: ExpectedResolvedTarget;
} & SettlePostActionObservationOptions;

export type { LongPressCommandResult };

export type HoverCommandOptions = CommandContext & {
  target: InteractionTarget;
  /** ADR 0012 step 4: replay-only post-resolution guard; see resolution.ts. */
  expectedResolvedTarget?: ExpectedResolvedTarget;
} & SettlePostActionObservationOptions;

export type { HoverCommandResult };

export type GestureDirection = ScrollDirection;
// The input vocabulary lives in contracts/scroll-gesture.ts beside the other scroll vocabularies,
// so the public API can declare `ScrollOptions` without depending on this command runtime.
export {
  SCROLL_INPUT_DIRECTIONS,
  type ScrollInputDirection,
} from '@agent-device/contracts/interaction';

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

export const focusCommand: RuntimeCommand<FocusCommandOptions, FocusCommandResult> = async (
  runtime,
  options,
): Promise<FocusCommandResult> => {
  const resolved = await resolveInteractionTarget(runtime, options, {
    action: 'focus',
    requireInteractive: true,
    pipeline: SELECTOR_PIPELINE_POLICIES.resolvedTarget,
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
  const observation = planPostActionObservation(options);
  const resolved = await resolveInteractionTarget(runtime, options, {
    action: 'longPress',
    requireInteractive: true,
    pipeline: SELECTOR_PIPELINE_POLICIES.promotedTarget,
    captureEvidenceBaseline: observation.needsPreActionBaseline,
    expectedResolvedTarget: options.expectedResolvedTarget,
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
  return await applyPostActionObservation(
    runtime,
    options,
    resolved,
    {
      ...resolved,
      ...(durationMs !== undefined ? { durationMs } : {}),
      ...(formattedBackendResult ? { backendResult: formattedBackendResult } : {}),
      ...successText(`Long pressed (${point.x}, ${point.y})`),
    },
    observation,
  );
};

export const hoverCommand: RuntimeCommand<HoverCommandOptions, HoverCommandResult> = async (
  runtime,
  options,
): Promise<HoverCommandResult> => {
  const observation = planPostActionObservation(options);
  const nativeRefHover = observation.needsPreActionBaseline
    ? null
    : await maybeHoverRefTarget(runtime, options);
  if (nativeRefHover) return nativeRefHover;
  // Hover keeps the element it resolved (no hittable-ancestor promotion): the
  // pointer only has to enter the matched node's box for its hover state to
  // raise, and promoting could move it onto a sibling-owned region.
  const resolved = await resolveInteractionTarget(runtime, options, {
    action: 'hover',
    requireInteractive: false,
    pipeline: SELECTOR_PIPELINE_POLICIES.resolvedTarget,
    captureEvidenceBaseline: observation.needsPreActionBaseline,
    expectedResolvedTarget: options.expectedResolvedTarget,
  });
  if (!runtime.backend.hover) {
    throw new AppError('UNSUPPORTED_OPERATION', 'hover is not supported by this backend');
  }
  const point = requireResolvedPoint(resolved);
  const backendResult = await runtime.backend.hover(toBackendContext(runtime, options), point);
  const formattedBackendResult = toBackendResult(backendResult);
  return await applyPostActionObservation(
    runtime,
    options,
    resolved,
    {
      ...resolved,
      ...(formattedBackendResult ? { backendResult: formattedBackendResult } : {}),
      ...successText(`Hovered (${point.x}, ${point.y})`),
    },
    observation,
  );
};

/**
 * ADR 0011 `native-ref` path for hover: on web the ref IS the provider's own
 * element handle (`hoverRef`), and the session's ref frame carries no rects,
 * so a coordinate hover could not resolve it. Mirrors `maybeTapRefTarget`:
 * the shared preflight guards run against the stored node, a guarded replay
 * dispatch takes the runtime path, and `--settle` (which needs a pre-action
 * baseline) is routed by the caller before reaching here.
 */
async function maybeHoverRefTarget(
  runtime: AgentDeviceRuntime,
  options: HoverCommandOptions,
): Promise<HoverCommandResult | null> {
  if (options.target.kind !== 'ref' || !runtime.backend.hoverTarget) return null;
  if (options.expectedResolvedTarget) return null;
  const { hoverTarget } = runtime.backend;
  return await dispatchNativeRefInteraction(
    runtime,
    options,
    options.target,
    'hover',
    async (context, refTarget) => await hoverTarget(context, refTarget),
  );
}

export const dragCommand: RuntimeCommand<DragCommandOptions, DragCommandResult> = async (
  runtime,
  options,
) => {
  if (!runtime.backend.performGesture) {
    throw new AppError('UNSUPPORTED_OPERATION', 'gesture is not supported by this backend');
  }
  await assertSupportedInteractionSurface(runtime, options, 'drag');
  const viewport = await resolveGestureViewport(runtime, options);
  const source = await resolveDragTarget(runtime, options, 'source');
  const destination = await resolveDragTarget(runtime, options, 'destination');
  const plan = buildDragGesturePlan(
    {
      from: requireResolvedPoint(source),
      to: requireResolvedPoint(destination),
      sourceHoldMs: options.gesture.sourceHoldMs,
      moveMs: options.gesture.moveMs,
      destinationHoldMs: options.gesture.destinationHoldMs,
    },
    viewport,
  );
  const backendResult = await runtime.backend.performGesture(
    toBackendContext(runtime, options),
    plan,
  );
  const formattedBackendResult = toBackendResult(backendResult);
  const { start: from, end: to } = singlePointerPlanEndpoints(plan);
  return {
    kind: 'drag',
    durationMs: plan.durationMs,
    pointerCount: 1,
    from,
    to,
    targets: {
      source: dragTargetDisclosure(source),
      destination: dragTargetDisclosure(destination),
    },
    recording: dragRecordingDetails(source, destination),
    ...(formattedBackendResult ? { backendResult: formattedBackendResult } : {}),
    ...successText(`Dragged ${options.gesture.source} to ${options.gesture.destination}`),
  };
};

async function resolveDragTarget(
  runtime: AgentDeviceRuntime,
  options: DragCommandOptions,
  endpoint: 'source' | 'destination',
): Promise<ResolvedInteractionTarget> {
  const token = options.gesture[endpoint];
  return await resolveInteractionTarget(
    runtime,
    {
      ...options,
      target: token.startsWith('@')
        ? { kind: 'ref', ref: token }
        : { kind: 'selector', selector: token },
    },
    {
      action: 'drag',
      requireInteractive: false,
      pipeline: SELECTOR_PIPELINE_POLICIES.resolvedTarget,
      expectedResolvedTarget: options.expectedResolvedTargets?.[endpoint],
      replayTargetRole: endpoint,
    },
  );
}

function dragTargetDisclosure(target: ResolvedInteractionTarget): DragTargetDisclosure {
  if (target.kind === 'point' || !target.resolution) {
    throw new AppError('COMMAND_FAILED', 'gesture drag target resolution was not disclosed');
  }
  const selectorChain = 'selectorChain' in target ? target.selectorChain : undefined;
  return {
    ...(selectorChain?.length ? { selectorChain } : {}),
    resolution: target.resolution,
  };
}

function dragRecordingDetails(
  source: ResolvedInteractionTarget,
  destination: ResolvedInteractionTarget,
): NonNullable<DragCommandResult['recording']> {
  const sourceSelector = selectorExpression(source);
  const destinationSelector = selectorExpression(destination);
  const sourceTarget = recordedDragTarget(source);
  const destinationTarget = recordedDragTarget(destination);
  return {
    ...(sourceSelector ? { sourceSelector } : {}),
    ...(destinationSelector ? { destinationSelector } : {}),
    ...(sourceTarget ? { sourceTarget } : {}),
    ...(destinationTarget ? { destinationTarget } : {}),
  };
}

function selectorExpression(target: ResolvedInteractionTarget): string | undefined {
  return 'selectorChain' in target && target.selectorChain?.length
    ? target.selectorChain.join(' || ')
    : undefined;
}

function recordedDragTarget(target: ResolvedInteractionTarget): DragRecordingTarget | undefined {
  if (
    !('selectorChain' in target) ||
    !target.selectorChain?.length ||
    !target.node ||
    !target.preActionNodes
  ) {
    return undefined;
  }
  return {
    selectorChain: target.selectorChain,
    node: target.node,
    preActionNodes: target.preActionNodes,
  };
}

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
  const executionOptions = resolveScrollExecutionOptions(
    {
      ...(amount !== undefined ? { amount } : {}),
      ...(pixels !== undefined ? { pixels } : {}),
      ...(durationMs !== undefined ? { durationMs } : {}),
    },
    target.edge,
  );
  const runScroll = async () =>
    await scrollBackend(toBackendContext(runtime, options), backendTarget, {
      direction: target.direction,
      ...executionOptions,
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
      pipeline: SELECTOR_PIPELINE_POLICIES.resolvedTarget,
    },
  );
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
