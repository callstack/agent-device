import type { CommandContext } from '@agent-device/contracts/runtime-contract';
import type {
  GestureCommandInput,
  GestureContactCount,
  GestureIntent,
  GestureSemanticInput,
  TargetedPinchGestureInput,
} from '@agent-device/contracts/gesture-plan-types';
import { buildGesturePlan } from '@agent-device/gestures/gesture-plan';
import type { Point } from '@agent-device/kernel/snapshot';
import { AppError } from '@agent-device/kernel/errors';
import { recordedSelectorExpression } from '@agent-device/selectors';
import { SELECTOR_PIPELINE_POLICIES } from '@agent-device/selectors/selector-pipeline-policy';
import { successText } from '@agent-device/kernel/success-text';
import { toBackendContext } from '../../runtime-common.ts';
import {
  toBackendResult,
  type BackendResultEnvelope,
  type RuntimeCommand,
} from '../../runtime-types.ts';
import { assertSupportedInteractionSurface, resolveInteractionTarget } from './resolution.ts';
import {
  dragCommand,
  resolveGestureViewport,
  type DragCommandOptions,
  type DragCommandResult,
} from './gestures.ts';

type CoordinateGestureCommandOptions = CommandContext & {
  gesture: GestureSemanticInput;
};

type TargetedPinchCommandOptions = CommandContext & {
  gesture: TargetedPinchGestureInput;
};

export type GestureCommandOptions =
  | CoordinateGestureCommandOptions
  | DragCommandOptions
  | TargetedPinchCommandOptions;

export type CoordinateGestureCommandResult = {
  kind: GestureIntent;
  durationMs: number;
  pointerCount: GestureContactCount;
  from: Point;
  to: Point;
  /** The selector a targeted pinch resolved, so a recorded `.ad` line replays without a ref. */
  recordedTargetSelector?: string;
} & BackendResultEnvelope;

export type GestureCommandResult = CoordinateGestureCommandResult | DragCommandResult;

const coordinateGestureCommand: RuntimeCommand<
  CoordinateGestureCommandOptions,
  CoordinateGestureCommandResult
> = async (runtime, options) => {
  if (!runtime.backend.performGesture) {
    throw new AppError('UNSUPPORTED_OPERATION', 'gesture is not supported by this backend');
  }
  await assertSupportedInteractionSurface(runtime, options, options.gesture.intent);
  const performGesture = runtime.backend.performGesture;
  const plan = buildGesturePlan(
    options.gesture,
    await resolveGestureViewport(runtime, options),
    runtime.backend.platform,
  );
  const backendResult = await performGesture(toBackendContext(runtime, options), plan);
  const formattedBackendResult = toBackendResult(backendResult);
  const from = centroidAt(plan.pointers, 0);
  const to = centroidAt(plan.pointers, -1);
  return {
    kind: options.gesture.intent,
    durationMs: plan.durationMs,
    pointerCount: plan.pointers.length as GestureContactCount,
    from,
    to,
    ...(formattedBackendResult ? { backendResult: formattedBackendResult } : {}),
    ...successText(gestureMessage(options.gesture, from, to)),
  };
};

export const gestureCommand: RuntimeCommand<GestureCommandOptions, GestureCommandResult> = async (
  runtime,
  options,
) => {
  const gesture: GestureCommandInput = options.gesture;
  if (gesture.intent === 'drag') return await dragCommand(runtime, { ...options, gesture });
  if ('element' in gesture) return await targetedPinchCommand(runtime, { ...options, gesture });
  return await coordinateGestureCommand(runtime, { ...options, gesture });
};

/** Resolves the pinch element to its touch point, then pinches around that point. */
const targetedPinchCommand: RuntimeCommand<
  TargetedPinchCommandOptions,
  CoordinateGestureCommandResult
> = async (runtime, options) => {
  const { element, scale } = options.gesture;
  const resolved = await resolveInteractionTarget(
    runtime,
    {
      ...options,
      target: element.startsWith('@')
        ? { kind: 'ref', ref: element }
        : { kind: 'selector', selector: element },
    },
    {
      action: 'pinch',
      requireInteractive: false,
      pipeline: SELECTOR_PIPELINE_POLICIES.resolvedTarget,
    },
  );
  if (!resolved.point) {
    throw new AppError('COMMAND_FAILED', 'Interaction target resolved without coordinates');
  }
  const result = await coordinateGestureCommand(runtime, {
    ...options,
    gesture: { intent: 'pinch', origin: resolved.point, scale },
  });
  const selectorChain = 'selectorChain' in resolved ? resolved.selectorChain : undefined;
  return selectorChain?.length
    ? { ...result, recordedTargetSelector: recordedSelectorExpression(selectorChain) }
    : result;
};

function centroidAt(
  pointers: readonly { samples: readonly { point: Point }[] }[],
  index: 0 | -1,
): Point {
  const points = pointers.map((pointer) =>
    index === 0 ? pointer.samples[0]?.point : pointer.samples.at(-1)?.point,
  );
  if (points.some((point) => point === undefined)) {
    throw new AppError('COMMAND_FAILED', 'Gesture plan did not contain endpoint samples.');
  }
  const defined = points as Point[];
  return {
    x: defined.reduce((sum, point) => sum + point.x, 0) / defined.length,
    y: defined.reduce((sum, point) => sum + point.y, 0) / defined.length,
  };
}

function gestureMessage(input: GestureSemanticInput, from: Point, to: Point): string {
  switch (input.intent) {
    case 'pan': {
      const origin = 'preset' in input ? from : input.origin;
      const delta = 'preset' in input ? { x: to.x - from.x, y: to.y - from.y } : input.delta;
      return `Panned (${origin.x}, ${origin.y}) by (${delta.x}, ${delta.y})`;
    }
    case 'fling':
      return 'direction' in input ? `Flung ${input.direction}` : 'Flung';
    case 'pinch':
      return `Pinched to scale ${input.scale}`;
    case 'rotate':
      return `Rotated gesture ${input.degrees} degrees`;
    case 'transform':
      return `Requested transform gesture by (${input.delta.x}, ${input.delta.y}), scale ${input.scale}, rotate ${input.degrees} degrees`;
    case 'tap':
      return `Tapped ${input.points.length} points`;
  }
}
