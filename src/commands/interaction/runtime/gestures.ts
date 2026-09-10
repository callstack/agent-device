import type { DragGestureInput } from '@agent-device/contracts/gesture-plan-types';
import type {
  HoverCommandResult,
  LongPressCommandResult,
  ResolutionDisclosure,
} from '@agent-device/contracts/interaction';
import {
  buildDragGesturePlan,
  singlePointerPlanEndpoints,
} from '@agent-device/contracts/gesture-plan';
import { AppError } from '@agent-device/kernel/errors';
import { SELECTOR_PIPELINE_POLICIES } from '@agent-device/selectors/selector-pipeline-policy';
import type { Point, Rect, SnapshotNode } from '@agent-device/kernel/snapshot';
import type { AgentDeviceRuntime, CommandContext } from '../../../runtime-contract.ts';
import { successText } from '@agent-device/kernel/success-text';
import { requireIntInRange } from '@agent-device/kernel/validation';
import { toBackendContext } from '../../runtime-common.ts';
import {
  toBackendResult,
  type BackendResultEnvelope,
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

function requireResolvedPoint(result: { point?: Point }): Point {
  if (!result.point) {
    throw new AppError('COMMAND_FAILED', 'Interaction target resolved without coordinates');
  }
  return result.point;
}
