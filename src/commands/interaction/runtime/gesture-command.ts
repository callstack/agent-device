import type { AgentDeviceRuntime, CommandContext } from '../../../runtime-contract.ts';
import type { GestureIntent, GestureSemanticInput } from '../../../contracts/gesture-plan-types.ts';
import { buildGesturePlan } from '../../../contracts/gesture-plan.ts';
import type { NormalizedGestureInput } from '../../../contracts/gesture-normalization.ts';
import { buildSwipePresetGesturePlan } from '../../../contracts/scroll-gesture.ts';
import type { Point, Rect } from '../../../kernel/snapshot.ts';
import { AppError } from '../../../kernel/errors.ts';
import { successText } from '../../../utils/success-text.ts';
import { toBackendContext } from '../../runtime-common.ts';
import {
  toBackendResult,
  type BackendResultEnvelope,
  type RuntimeCommand,
} from '../../runtime-types.ts';
import { assertSupportedInteractionSurface, captureInteractionSnapshot } from './resolution.ts';
import { resolveVisibleSnapshotViewport } from './viewport.ts';

export type GestureCommandOptions = CommandContext & {
  gesture: NormalizedGestureInput;
};

export type GestureCommandResult = {
  kind: GestureIntent;
  durationMs: number;
  pointerCount: 1 | 2;
  from: Point;
  to: Point;
} & BackendResultEnvelope;

export type PanCommandOptions = CommandContext &
  Omit<Extract<GestureSemanticInput, { intent: 'pan' }>, 'intent'>;
export type FlingCommandOptions = CommandContext &
  Omit<Extract<GestureSemanticInput, { intent: 'fling'; direction: unknown }>, 'intent'>;
export type RotateGestureCommandOptions = CommandContext &
  Omit<Extract<GestureSemanticInput, { intent: 'rotate' }>, 'intent'>;
export type TransformGestureCommandOptions = CommandContext &
  Omit<Extract<GestureSemanticInput, { intent: 'transform' }>, 'intent'>;

export const gestureCommand: RuntimeCommand<GestureCommandOptions, GestureCommandResult> = async (
  runtime,
  options,
) => {
  if (!runtime.backend.performGesture) {
    throw new AppError('UNSUPPORTED_OPERATION', 'gesture is not supported by this backend');
  }
  await assertSupportedInteractionSurface(runtime, options, options.gesture.intent);
  const viewport = await captureGestureViewport(runtime, options);
  const gesture = resolvePresetGesture(options.gesture, viewport);
  const plan = buildGesturePlan(gesture, viewport, runtime.backend.platform);
  const backendResult = await runtime.backend.performGesture(
    toBackendContext(runtime, options),
    plan,
  );
  const formattedBackendResult = toBackendResult(backendResult);
  const from = centroidAt(plan.pointers, 0);
  const to = centroidAt(plan.pointers, -1);
  return {
    kind: gesture.intent,
    durationMs: plan.durationMs,
    pointerCount: plan.topology === 'single' ? 1 : 2,
    from,
    to,
    ...(formattedBackendResult ? { backendResult: formattedBackendResult } : {}),
    ...successText(gestureMessage(gesture)),
  };
};

export const panCommand: RuntimeCommand<PanCommandOptions, GestureCommandResult> = async (
  runtime,
  options,
) => await gestureCommand(runtime, { ...options, gesture: { ...options, intent: 'pan' } });

export const flingCommand: RuntimeCommand<FlingCommandOptions, GestureCommandResult> = async (
  runtime,
  options,
) => await gestureCommand(runtime, { ...options, gesture: { ...options, intent: 'fling' } });

export const rotateGestureCommand: RuntimeCommand<
  RotateGestureCommandOptions,
  GestureCommandResult
> = async (runtime, options) =>
  await gestureCommand(runtime, { ...options, gesture: { ...options, intent: 'rotate' } });

export const transformGestureCommand: RuntimeCommand<
  TransformGestureCommandOptions,
  GestureCommandResult
> = async (runtime, options) =>
  await gestureCommand(runtime, { ...options, gesture: { ...options, intent: 'transform' } });

async function captureGestureViewport(
  runtime: AgentDeviceRuntime,
  options: GestureCommandOptions,
): Promise<Rect> {
  const backendViewport = await runtime.backend.resolveGestureViewport?.(
    toBackendContext(runtime, options),
  );
  if (backendViewport) return backendViewport;
  const capture = await captureInteractionSnapshot(runtime, options, false);
  return resolveVisibleSnapshotViewport(capture.snapshot.nodes, 'gesture');
}

function resolvePresetGesture(input: NormalizedGestureInput, viewport: Rect): GestureSemanticInput {
  if (!('preset' in input)) return input;
  const relative = buildSwipePresetGesturePlan(input.preset, {
    referenceWidth: viewport.width,
    referenceHeight: viewport.height,
  });
  const from = { x: viewport.x + relative.x1, y: viewport.y + relative.y1 };
  const to = { x: viewport.x + relative.x2, y: viewport.y + relative.y2 };
  if (input.intent === 'fling') return { intent: 'fling', from, to };
  return {
    intent: 'pan',
    origin: from,
    delta: { x: to.x - from.x, y: to.y - from.y },
    durationMs: input.durationMs,
  };
}

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

function gestureMessage(input: GestureSemanticInput): string {
  switch (input.intent) {
    case 'pan':
      return `Panned (${input.origin.x}, ${input.origin.y}) by (${input.delta.x}, ${input.delta.y})`;
    case 'fling':
      return 'direction' in input ? `Flung ${input.direction}` : 'Flung';
    case 'pinch':
      return `Pinched to scale ${input.scale}`;
    case 'rotate':
      return `Rotated gesture ${input.degrees} degrees`;
    case 'transform':
      return `Requested transform gesture by (${input.delta.x}, ${input.delta.y}), scale ${input.scale}, rotate ${input.degrees} degrees`;
  }
}
