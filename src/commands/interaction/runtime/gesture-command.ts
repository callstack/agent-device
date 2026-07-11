import type { AgentDeviceRuntime, CommandContext } from '../../../runtime-contract.ts';
import { buildGesturePlan } from '../../../core/gesture-plan.ts';
import type { GestureSemanticInput } from '../../../core/gesture-plan-types.ts';
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
  gesture: GestureSemanticInput;
};

export type GestureCommandResult = {
  kind: GestureSemanticInput['intent'];
  durationMs: number;
  from?: Point;
  to?: Point;
} & BackendResultEnvelope;

export type PanCommandOptions = CommandContext &
  Omit<Extract<GestureSemanticInput, { intent: 'pan' }>, 'intent'>;
export type FlingCommandOptions = CommandContext &
  Omit<Extract<GestureSemanticInput, { intent: 'fling' }>, 'intent'>;
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
  const viewport = gestureNeedsViewport(options.gesture)
    ? await captureGestureViewport(runtime, options)
    : undefined;
  const plan = buildGesturePlan(options.gesture, viewport);
  const backendResult = await runtime.backend.performGesture(
    toBackendContext(runtime, options),
    plan,
  );
  const formattedBackendResult = toBackendResult(backendResult);
  const compactPath =
    plan.topology === 'single'
      ? {
          from: plan.pointers[0].samples[0]?.point,
          to: plan.pointers[0].samples.at(-1)?.point,
        }
      : {};
  return {
    kind: options.gesture.intent,
    durationMs: plan.durationMs,
    ...compactPath,
    ...(formattedBackendResult ? { backendResult: formattedBackendResult } : {}),
    ...successText(gestureMessage(options.gesture)),
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

function gestureNeedsViewport(input: GestureSemanticInput): boolean {
  if (input.intent === 'swipe') return 'preset' in input;
  if (input.intent === 'pan') return (input.pointerCount ?? 1) === 2;
  return input.intent === 'pinch' || input.intent === 'rotate' || input.intent === 'transform';
}

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

function gestureMessage(input: GestureSemanticInput): string {
  switch (input.intent) {
    case 'swipe':
      return 'preset' in input ? `Swiped ${input.preset}` : 'Swiped';
    case 'pan':
      return `Panned (${input.origin.x}, ${input.origin.y}) by (${input.delta.x}, ${input.delta.y})`;
    case 'fling':
      return `Flung ${input.direction}`;
    case 'pinch':
      return `Pinched to scale ${input.scale}`;
    case 'rotate':
      return `Rotated gesture ${input.degrees} degrees`;
    case 'transform':
      return `Requested transform gesture by (${input.delta.x}, ${input.delta.y}), scale ${input.scale}, rotate ${input.degrees} degrees`;
  }
}
