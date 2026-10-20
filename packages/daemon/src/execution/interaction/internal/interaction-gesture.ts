import type { DaemonResponse } from '@agent-device/kernel/contracts';
import { bindInteractionSession } from './interaction-session.ts';
import { readOptionalInteger } from '@agent-device/contracts/command';
import { type GesturePayload, readGesturePayload } from '@agent-device/contracts/gesture-input';
import {
  type SwipePayload,
  assertNoRemovedSwipeInput,
  gesturePayloadToPositionals,
  normalizeGestureCommandInput,
  normalizePublicSwipeMotion,
} from '@agent-device/contracts/gesture-normalization';
import { GESTURE_FLING_DURATION_MS } from '@agent-device/contracts/gesture-plan';
import type {
  GestureCommandInput,
  GestureExecutionProfile,
} from '@agent-device/contracts/gesture-plan-types';
import {
  SWIPE_PAUSE_MAX_MS,
  SWIPE_REPETITION_MAX,
  SWIPE_SERIES_MAX_SCHEDULED_DURATION_MS,
} from '@agent-device/contracts/scroll-gesture';
import { AppError, asAppError, normalizeError } from '@agent-device/kernel/errors';
import {
  REF_GRAMMAR_HINT,
  splitRefGenerationSuffix,
  type Point,
} from '@agent-device/kernel/snapshot';
import {
  resolveBoundGestureRuntime,
  type BoundGestureExecutor,
} from '../../../core/gesture-runtime.ts';
import { isActiveProviderDevice } from '../../../core/provider-device-admission.ts';
import { sleep } from '@agent-device/host-kit/retry';
import { getRequestSignal } from '@agent-device/host-kit/request';
import {
  ensureAndroidBlockingSystemDialogReady,
  type AndroidBlockingDialogReadinessResult,
} from '../../android-system-dialog.ts';
import { readRefMutationFrame } from '../../../core/ref-frame.ts';
import { thrownBeforeDispatch } from '../../request-dispatch-disclosure.ts';
import type { SessionState } from '../../../core/session-state.ts';
import { assertRefMutationAdmitted } from './interaction-ref-policy.ts';
import {
  createInteractionRuntimeForRoute,
  finalizeTouchInteraction,
} from './interaction-runtime.ts';
import type {
  CaptureSnapshotForSession,
  InteractionRouteInput,
} from '../../../core/interaction/internal/types.ts';
import type { RecordedTargetCapture } from '@agent-device/selectors/target-evidence';
import { gestureResponseData } from './interaction-gesture-response.ts';
import { noActiveSessionError } from '@agent-device/kernel/contracts';

type GestureHandlerParams = InteractionRouteInput & {
  captureSnapshotForSession: CaptureSnapshotForSession;
};

type GestureRuntime = Awaited<ReturnType<typeof createInteractionRuntimeForRoute>>;
type GestureRuntimeResult = Awaited<ReturnType<GestureRuntime['interactions']['gesture']>>;

type GestureInteractionOutcome = {
  positionals: string[];
  flags: InteractionRouteInput['req']['flags'];
  responseData: Record<string, unknown>;
  recordingResultExtra?: Record<string, unknown>;
  recordedTargets?: { source: RecordedTargetCapture; destination: RecordedTargetCapture };
};

/**
 * A refused gesture short-circuits with the admission's own response. The retired
 * `requireGestureSupported` threw, so the refusal skipped the after-command dialog check and
 * returned the normalized error; returning it here preserves that control flow exactly.
 */
type GestureInteractionResult = GestureInteractionOutcome | Readonly<{ refused: DaemonResponse }>;

function isRefusal(
  result: GestureInteractionResult,
): result is Readonly<{ refused: DaemonResponse }> {
  return 'refused' in result;
}

export async function dispatchGestureViaRuntime(
  params: GestureHandlerParams,
): Promise<DaemonResponse> {
  params = bindInteractionSession(params);
  return await dispatchGestureInteraction(params, 'gesture', async (session, readiness) =>
    runGestureInteraction(params, session, readiness),
  );
}

async function runGestureInteraction(
  params: GestureHandlerParams,
  session: SessionState,
  readiness: AndroidBlockingDialogReadinessResult,
): Promise<GestureInteractionResult> {
  const input = readGesturePayload(params.req.input);
  const gesture = prepareGestureCommandInput(input, session, readiness);
  if (gesture.intent === 'pan' && params.req.internal?.gestureExecutionProfile) {
    gesture.executionProfile = params.req.internal.gestureExecutionProfile;
  }
  // ADR 0019 §9: the gesture input selects one execution tier and this is the request's ONE bind,
  // taken before any plan is built — a drag binds here, not after its targets resolve.
  const bound = await resolveBoundGestureRuntime({
    device: session.device,
    input: gesture,
    inspectFacts: params.inspectFacts,
    platformServices: params.platformServices,
    bindDevice: params.bindDevice,
  });
  if (!bound.ok) return { refused: bound.response };
  const runtime = await createGestureRuntime(params, bound.gestures);
  const context = { session: params.sessionName, requestId: params.req.meta?.requestId };
  const result =
    input.kind === 'tap'
      ? await runGestureRepetitions(
          runtime,
          params,
          input.count ?? 1,
          input.pauseMs ?? 0,
          () => gesture,
        )
      : await runPreparedGesture(runtime, context, gesture, params.req.internal);
  return buildGestureOutcome(input, gesture, result, params.req.flags);
}

async function runPreparedGesture(
  runtime: GestureRuntime,
  context: { session: string; requestId: string | undefined },
  gesture: GestureCommandInput,
  internal: InteractionRouteInput['req']['internal'],
): Promise<GestureRuntimeResult> {
  if (gesture.intent !== 'drag') {
    return await runtime.interactions.gesture({ ...context, gesture });
  }
  const expectedResolvedTargets =
    internal?.replayTargetGuards ??
    (internal?.replayTargetGuard ? { source: internal.replayTargetGuard } : undefined);
  return await runtime.interactions.gesture({
    ...context,
    gesture,
    ...(expectedResolvedTargets ? { expectedResolvedTargets } : {}),
  });
}

function buildGestureOutcome(
  input: GesturePayload,
  gesture: GestureCommandInput,
  result: GestureRuntimeResult,
  flags: InteractionRouteInput['req']['flags'],
): GestureInteractionOutcome {
  const recording = result.kind === 'drag' ? result.recording : undefined;
  const sourceTarget = recording?.sourceTarget;
  const destinationTarget = recording?.destinationTarget;
  const responseResult =
    input.kind === 'tap' && (input.count ?? 1) > 1
      ? { ...result, message: `Tapped ${input.points.length} points ${input.count} times` }
      : result;
  return {
    positionals: dragRecordingPositionals(input, recording),
    flags: gestureReplayFlags(input, flags),
    responseData: gestureResponseData(responseResult, {
      executionProfile: resolveExecutionProfile(gesture),
      ...(input.kind === 'tap'
        ? {
            points: input.points,
            holdMs: result.durationMs,
            count: input.count ?? 1,
            pauseMs: input.pauseMs ?? 0,
          }
        : {}),
    }),
    ...(input.kind === 'pinch'
      ? { recordingResultExtra: { scale: input.scale } }
      : sourceTarget
        ? { recordingResultExtra: { selectorChain: sourceTarget.selectorChain } }
        : {}),
    ...(sourceTarget && destinationTarget
      ? {
          recordedTargets: {
            source: { node: sourceTarget.node, preActionNodes: sourceTarget.preActionNodes },
            destination: {
              node: destinationTarget.node,
              preActionNodes: destinationTarget.preActionNodes,
            },
          },
        }
      : {}),
  };
}

export async function dispatchSwipeViaRuntime(
  params: GestureHandlerParams,
): Promise<DaemonResponse> {
  params = bindInteractionSession(params);
  return await dispatchGestureInteraction(params, 'swipe', async (session) => {
    const input = readSwipeInput(params.req.input);
    // One bind for the whole series: `--count N` executes the bound operation N times under a
    // single binding, never one bind per repetition (ADR 0019 §9).
    const bound = await resolveBoundGestureRuntime({
      device: session.device,
      input: normalizePublicSwipeMotion(input).gesture,
      inspectFacts: params.inspectFacts,
      platformServices: params.platformServices,
      bindDevice: params.bindDevice,
    });
    if (!bound.ok) return { refused: bound.response };
    const count = input.count ?? 1;
    const pauseMs = input.pauseMs ?? 0;
    const pattern = input.pattern ?? 'one-way';
    const runtime = await createGestureRuntime(params, bound.gestures);
    const result = await runGestureRepetitions(
      runtime,
      params,
      count,
      pauseMs,
      (index) => normalizePublicSwipeMotion(swipeMotionAtIndex(input, pattern, index)).gesture,
    );
    return {
      positionals: swipeReplayPositionals(input),
      flags: params.req.flags,
      responseData: gestureResponseData(result, {
        from: input.from,
        to: input.to,
        x1: input.from.x,
        y1: input.from.y,
        x2: input.to.x,
        y2: input.to.y,
        effectiveDurationMs: result.durationMs,
        timingMode: 'direct',
        executionProfile: 'endpoint-hold',
        count,
        pauseMs,
        pattern,
      }),
    };
  });
}

function createGestureRuntime(
  params: GestureHandlerParams,
  gestures: BoundGestureExecutor,
): Promise<GestureRuntime> {
  return createInteractionRuntimeForRoute({
    ...params,
    gestures,
    pairedGestureViewport: params.req.internal?.gestureViewport,
  });
}

async function dispatchGestureInteraction(
  params: GestureHandlerParams,
  command: 'gesture' | 'swipe',
  run: (
    session: SessionState,
    readiness: AndroidBlockingDialogReadinessResult,
  ) => Promise<GestureInteractionResult>,
): Promise<DaemonResponse> {
  const session = params.sessionStore.get(params.sessionName);
  if (!session) return noActiveSessionError();
  const actionStartedAt = Date.now();
  try {
    const providerDevice = isActiveProviderDevice(session.device);
    const readiness = providerDevice
      ? ({ status: 'clear' } as const)
      : await ensureAndroidBlockingSystemDialogReady({
          session,
          command,
          phase: 'before-command',
          observation: params.androidObservation,
        });
    const outcome = await run(session, readiness);
    if (isRefusal(outcome)) return outcome.refused;
    getRequestSignal(params.req.meta?.requestId)?.throwIfAborted();
    if (!providerDevice) {
      await ensureAndroidBlockingSystemDialogReady({
        session,
        command,
        phase: 'after-command',
        observation: params.androidObservation,
      });
    }
    const responseData = { ...outcome.responseData };
    if (readiness.status === 'recovered') {
      const existingWarning =
        typeof responseData.warning === 'string' ? `${responseData.warning} ` : '';
      responseData.warning = `${existingWarning}${readiness.warning}`;
    }
    getRequestSignal(params.req.meta?.requestId)?.throwIfAborted();
    return finalizeTouchInteraction({
      ref: params.sessionRef!,
      sessionStore: params.sessionStore,
      command,
      actionCommand: command,
      positionals: outcome.positionals,
      flags: outcome.flags,
      result: { ...responseData, ...(outcome.recordingResultExtra ?? {}) },
      responseData,
      recordedTargets: outcome.recordedTargets,
      actionStartedAt,
      actionFinishedAt: Date.now(),
    });
  } catch (error) {
    return { ok: false, error: normalizeError(error) };
  }
}

function resolveExecutionProfile(
  gesture: GestureCommandInput,
): GestureExecutionProfile | undefined {
  if (gesture.intent === 'fling') return 'endpoint-hold';
  if (gesture.intent === 'pan') return gesture.executionProfile ?? 'timed-pan';
  if (gesture.intent === 'drag') return 'timed-pan';
  return undefined;
}

function prepareGestureCommandInput(
  input: GesturePayload,
  session: SessionState,
  readiness: AndroidBlockingDialogReadinessResult,
): GestureCommandInput {
  const normalized = normalizeGestureCommandInput(input);
  if (normalized.intent !== 'drag') return normalized;
  try {
    return {
      ...normalized,
      source: prepareDragTarget(normalized.source, session),
      destination: prepareDragTarget(normalized.destination, session),
    };
  } catch (error) {
    if (readiness.status === 'recovered') {
      const failure = asAppError(error);
      const existingWarning =
        typeof failure.details?.warning === 'string' ? failure.details.warning + ' ' : '';
      failure.details = { ...failure.details, warning: existingWarning + readiness.warning };
      throw failure;
    }
    throw thrownBeforeDispatch(error);
  }
}

function prepareDragTarget(target: string, session: SessionState): string {
  if (!target.startsWith('@')) return target;
  const split = splitRefGenerationSuffix(target);
  if (!split) {
    throw new AppError('INVALID_ARGS', `Invalid ref "${target}" — malformed generation suffix.`, {
      hint: REF_GRAMMAR_HINT,
    });
  }
  assertRefMutationAdmitted({
    ref: split.base,
    mintedGeneration: split.generation,
    frame: readRefMutationFrame({
      session,
      ref: split.base,
      mintedGeneration: split.generation,
    }),
  });
  return split.base;
}

function dragRecordingPositionals(
  input: GesturePayload,
  recording: Extract<GestureRuntimeResult, { kind: 'drag' }>['recording'],
): string[] {
  if (input.kind !== 'drag' || !recording) return gesturePayloadToPositionals(input);
  return gesturePayloadToPositionals({
    ...input,
    source: recording.sourceSelector ?? input.source,
    destination: recording.destinationSelector ?? input.destination,
  });
}

function readSwipeInput(input: unknown): SwipePayload {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new AppError('INVALID_ARGS', 'swipe requires structured object input');
  }
  assertNoRemovedSwipeInput(input);
  const record = input as Record<string, unknown>;
  const pattern = record.pattern;
  if (pattern !== undefined && pattern !== 'one-way' && pattern !== 'ping-pong') {
    throw new AppError('INVALID_ARGS', 'swipe pattern must be one-way or ping-pong');
  }
  const payload: SwipePayload = {
    from: readSwipePoint(record.from, 'swipe from'),
    to: readSwipePoint(record.to, 'swipe to'),
    count: readOptionalInteger(record, 'count', { min: 1, max: SWIPE_REPETITION_MAX }),
    pauseMs: readOptionalInteger(record, 'pauseMs', { min: 0, max: SWIPE_PAUSE_MAX_MS }),
    pattern,
  };
  assertSwipeSeriesFitsRequest(payload);
  return payload;
}

function assertSwipeSeriesFitsRequest(input: SwipePayload): void {
  const count = input.count ?? 1;
  const pauseMs = input.pauseMs ?? 0;
  const gestureDurationMs = GESTURE_FLING_DURATION_MS;
  const scheduledDurationMs = count * gestureDurationMs + Math.max(0, count - 1) * pauseMs;
  if (scheduledDurationMs <= SWIPE_SERIES_MAX_SCHEDULED_DURATION_MS) return;
  throw new AppError(
    'INVALID_ARGS',
    `Swipe series must fit within ${SWIPE_SERIES_MAX_SCHEDULED_DURATION_MS}ms.`,
    {
      count,
      pauseMs,
      gestureDurationMs,
      scheduledDurationMs,
      hint: 'Reduce --count or --pause-ms.',
    },
  );
}

function readSwipePoint(value: unknown, field: string): Point {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AppError('INVALID_ARGS', `${field} must be a point`);
  }
  const point = value as Record<string, unknown>;
  if (typeof point.x !== 'number' || !Number.isFinite(point.x)) {
    throw new AppError('INVALID_ARGS', `${field} x must be finite`);
  }
  if (typeof point.y !== 'number' || !Number.isFinite(point.y)) {
    throw new AppError('INVALID_ARGS', `${field} y must be finite`);
  }
  return { x: point.x, y: point.y };
}

function swipeReplayPositionals(input: SwipePayload): string[] {
  return [String(input.from.x), String(input.from.y), String(input.to.x), String(input.to.y)];
}

async function runGestureRepetitions(
  runtime: GestureRuntime,
  params: InteractionRouteInput,
  count: number,
  pauseMs: number,
  gestureAtIndex: (index: number) => GestureCommandInput,
): Promise<GestureRuntimeResult> {
  const signal = getRequestSignal(params.req.meta?.requestId);
  let result: GestureRuntimeResult | undefined;
  for (let index = 0; index < count; index += 1) {
    signal?.throwIfAborted();
    result = await runPreparedGesture(
      runtime,
      { session: params.sessionName, requestId: params.req.meta?.requestId },
      gestureAtIndex(index),
      params.req.internal,
    );
    if (pauseMs > 0 && index + 1 < count) await sleep(pauseMs, signal);
  }
  if (!result) throw new Error('Gesture orchestration did not execute a gesture.');
  return result;
}

function swipeMotionAtIndex(
  input: SwipePayload,
  pattern: 'one-way' | 'ping-pong',
  index: number,
): SwipePayload {
  const reverse = pattern === 'ping-pong' && index % 2 === 1;
  if (!reverse) return input;
  return { ...input, from: input.to, to: input.from };
}

/** The flag-carried gesture inputs a `.ad` line needs, whichever surface the request came from. */
function gestureReplayFlags(
  input: GesturePayload,
  flags: InteractionRouteInput['req']['flags'],
): InteractionRouteInput['req']['flags'] {
  if (input.kind === 'tap') {
    return {
      ...flags,
      ...(input.holdMs === undefined ? {} : { holdMs: input.holdMs }),
      ...(input.count === undefined ? {} : { count: input.count }),
      ...(input.pauseMs === undefined ? {} : { pauseMs: input.pauseMs }),
    };
  }
  if (input.kind !== 'pan' || input.pointerCount === undefined) return flags;
  return { ...flags, pointerCount: input.pointerCount };
}
