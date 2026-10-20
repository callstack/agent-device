import type { CommandContext } from '@agent-device/contracts/runtime-contract';
import type {
  GestureCommandInput,
  GestureContactCount,
  GestureIntent,
  GesturePlan,
  GestureSemanticInput,
} from '@agent-device/contracts/gesture-plan-types';
import type { BackendActionResult } from '@agent-device/contracts/backend';
import { buildGesturePlan } from '@agent-device/contracts/gesture-plan';
import type { Point } from '@agent-device/kernel/snapshot';
import { AppError } from '@agent-device/kernel/errors';
import { successText } from '@agent-device/kernel/success-text';
import { sleep, toBackendContext } from '../../runtime-common.ts';
import {
  toBackendResult,
  type BackendResultEnvelope,
  type RuntimeCommand,
} from '../../runtime-types.ts';
import { assertSupportedInteractionSurface } from './resolution.ts';
import {
  dragCommand,
  resolveGestureViewport,
  type DragCommandOptions,
  type DragCommandResult,
} from './gestures.ts';

type CoordinateGestureCommandOptions = CommandContext & {
  gesture: GestureSemanticInput;
};

export type GestureCommandOptions = CoordinateGestureCommandOptions | DragCommandOptions;

/** What a tap series performed: the same planned contacts, `completed` of `count` times. */
export type TapSeriesResult = {
  points: Point[];
  holdMs: number;
  count: number;
  pauseMs: number;
  completed: number;
};

export type CoordinateGestureCommandResult = {
  kind: GestureIntent;
  durationMs: number;
  pointerCount: GestureContactCount;
  from: Point;
  to: Point;
  tapSeries?: TapSeriesResult;
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
  const planGesture = async () =>
    buildGesturePlan(
      options.gesture,
      await resolveGestureViewport(runtime, options),
      runtime.backend.platform,
    );
  const plan = await planGesture();
  const perform = async (planned: GesturePlan) =>
    await performGesture(toBackendContext(runtime, options), planned);
  const tapSeries =
    options.gesture.intent === 'tap'
      ? await performTapSeries(runtime, options, options.gesture, plan, planGesture, perform)
      : undefined;
  const backendResult = tapSeries ? tapSeries.lastResult : await perform(plan);
  const formattedBackendResult = toBackendResult(backendResult);
  const from = centroidAt(plan.pointers, 0);
  const to = centroidAt(plan.pointers, -1);
  return {
    kind: options.gesture.intent,
    durationMs: plan.durationMs,
    pointerCount: plan.pointers.length as GestureContactCount,
    from,
    to,
    ...(tapSeries ? { tapSeries: tapSeries.result } : {}),
    ...(formattedBackendResult ? { backendResult: formattedBackendResult } : {}),
    ...successText(gestureMessage(options.gesture, from, to, tapSeries?.result)),
  };
};

/**
 * Repeats a tap. Each repetition plans against a freshly resolved viewport (ADR 0013), so a
 * rotation between repetitions cannot land contacts on stale geometry. An aborted request stops
 * between repetitions and reports how many completed.
 */
async function performTapSeries(
  runtime: Parameters<typeof coordinateGestureCommand>[0],
  options: CommandContext,
  gesture: Extract<GestureSemanticInput, { intent: 'tap' }>,
  plan: GesturePlan,
  planGesture: () => Promise<GesturePlan>,
  perform: (plan: GesturePlan) => Promise<BackendActionResult>,
): Promise<{ result: TapSeriesResult; lastResult: BackendActionResult }> {
  const count = gesture.count ?? 1;
  const pauseMs = gesture.pauseMs ?? 0;
  const signal = options.signal ?? runtime.signal;
  let lastResult: BackendActionResult = undefined;
  let completed = 0;
  while (completed < count) {
    if (completed > 0 && pauseMs > 0) await sleep(runtime, pauseMs);
    if (completed > 0 && signal?.aborted) break;
    lastResult = await perform(completed === 0 ? plan : await planGesture());
    completed += 1;
  }
  return {
    result: {
      points: plan.pointers.map((pointer) => pointer.samples[0]!.point),
      holdMs: plan.durationMs,
      count,
      pauseMs,
      completed,
    },
    lastResult,
  };
}

export const gestureCommand: RuntimeCommand<GestureCommandOptions, GestureCommandResult> = async (
  runtime,
  options,
) => {
  const gesture: GestureCommandInput = options.gesture;
  if (gesture.intent === 'drag') return await dragCommand(runtime, { ...options, gesture });
  return await coordinateGestureCommand(runtime, { ...options, gesture });
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

function gestureMessage(
  input: GestureSemanticInput,
  from: Point,
  to: Point,
  tapSeries: TapSeriesResult | undefined,
): string {
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
      return tapMessage(input.points.length, tapSeries);
  }
}

function tapMessage(pointCount: number, tapSeries: TapSeriesResult | undefined): string {
  const base = `Tapped ${pointCount} points`;
  if (!tapSeries || tapSeries.count === 1) return base;
  if (tapSeries.completed < tapSeries.count) {
    return `${base} ${tapSeries.completed} of ${tapSeries.count} times; the request was cancelled`;
  }
  return `${base} ${tapSeries.count} times`;
}
