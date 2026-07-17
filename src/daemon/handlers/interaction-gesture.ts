import { readGesturePayload, type GesturePayload } from '../../contracts/gesture-input.ts';
import {
  gesturePayloadToPositionals,
  normalizePublicGesture,
  normalizePublicSwipeMotion,
  type SwipePayload,
} from '../../contracts/gesture-normalization.ts';
import { requireGestureSupported } from '../../core/capabilities.ts';
import { GESTURE_FLING_DURATION_MS } from '../../contracts/gesture-plan.ts';
import {
  SWIPE_PAUSE_MAX_MS,
  SWIPE_REPETITION_MAX,
  SWIPE_SERIES_MAX_SCHEDULED_DURATION_MS,
} from '../../contracts/scroll-gesture.ts';
import { AppError, normalizeError } from '../../kernel/errors.ts';
import { readOptionalInteger } from '../../kernel/input-validation.ts';
import type { Point } from '../../kernel/snapshot.ts';
import type { GestureSemanticInput } from '../../contracts/gesture-plan-types.ts';
import { isActiveProviderDevice } from '../../provider-device-runtime.ts';
import { sleep } from '../../utils/timeouts.ts';
import type { DaemonResponse, SessionState } from '../types.ts';
import { ensureAndroidBlockingSystemDialogReady } from '../android-system-dialog.ts';
import type { InteractionHandlerParams } from './interaction-common.ts';
import { finalizeTouchInteraction } from './interaction-common.ts';
import { createInteractionRuntime } from './interaction-runtime.ts';
import type { CaptureSnapshotForSession } from './interaction-snapshot.ts';
import { noActiveSessionError } from './response.ts';

type GestureHandlerParams = InteractionHandlerParams & {
  captureSnapshotForSession: CaptureSnapshotForSession;
};

type GestureRuntime = ReturnType<typeof createInteractionRuntime>;
type GestureRuntimeResult = Awaited<ReturnType<GestureRuntime['interactions']['gesture']>>;

type GestureInteractionOutcome = {
  positionals: string[];
  flags: InteractionHandlerParams['req']['flags'];
  responseData: Record<string, unknown>;
  recordingResultExtra?: Record<string, unknown>;
};

export async function dispatchGestureViaRuntime(
  params: GestureHandlerParams,
): Promise<DaemonResponse> {
  return await dispatchGestureInteraction(params, 'gesture', async (session) => {
    const input = readGesturePayload(params.req.input);
    const normalized = normalizePublicGesture(input);
    if (normalized.gesture.intent === 'pan' && params.req.internal?.gestureExecutionProfile) {
      normalized.gesture.executionProfile = params.req.internal.gestureExecutionProfile;
    }
    requireGestureSupported(normalized.gesture, session.device);
    const result = await createGestureRuntime(params).interactions.gesture({
      session: params.sessionName,
      requestId: params.req.meta?.requestId,
      gesture: normalized.gesture,
    });
    return {
      positionals: gesturePayloadToPositionals(input),
      flags: gestureReplayFlags(input, params.req.flags),
      responseData: gestureResponseData(result, {
        executionProfile: resolveExecutionProfile(normalized.gesture),
      }),
      ...(input.kind === 'pinch' ? { recordingResultExtra: { scale: input.scale } } : {}),
    };
  });
}

export async function dispatchSwipeViaRuntime(
  params: GestureHandlerParams,
): Promise<DaemonResponse> {
  return await dispatchGestureInteraction(params, 'swipe', async (session) => {
    const input = readSwipeInput(params.req.input);
    requireGestureSupported(normalizePublicSwipeMotion(input).gesture, session.device);
    const count = input.count ?? 1;
    const pauseMs = input.pauseMs ?? 0;
    const pattern = input.pattern ?? 'one-way';
    const runtime = createGestureRuntime(params);
    const result = await runSwipeRepetitions(runtime, params, input, count, pauseMs, pattern);
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

function createGestureRuntime(params: GestureHandlerParams) {
  return createInteractionRuntime({
    ...params,
    pairedGestureViewport: params.req.internal?.gestureViewport,
  });
}

async function dispatchGestureInteraction(
  params: GestureHandlerParams,
  command: 'gesture' | 'swipe',
  run: (session: SessionState) => Promise<GestureInteractionOutcome>,
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
        });
    const outcome = await run(session);
    if (!providerDevice) {
      await ensureAndroidBlockingSystemDialogReady({
        session,
        command,
        phase: 'after-command',
      });
    }
    const responseData = { ...outcome.responseData };
    if (readiness.status === 'recovered') {
      const existingWarning =
        typeof responseData.warning === 'string' ? `${responseData.warning} ` : '';
      responseData.warning = `${existingWarning}${readiness.warning}`;
    }
    return finalizeTouchInteraction({
      session,
      sessionStore: params.sessionStore,
      command,
      actionCommand: command,
      positionals: outcome.positionals,
      flags: outcome.flags,
      result: { ...responseData, ...(outcome.recordingResultExtra ?? {}) },
      responseData,
      actionStartedAt,
      actionFinishedAt: Date.now(),
    });
  } catch (error) {
    return { ok: false, error: normalizeError(error) };
  }
}

function resolveExecutionProfile(gesture: GestureSemanticInput): string | undefined {
  if (gesture.intent === 'fling') return 'endpoint-hold';
  if (gesture.intent === 'pan') return gesture.executionProfile ?? 'timed-pan';
  return undefined;
}

function gestureResponseData(
  result: GestureRuntimeResult,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  const executionProfile =
    typeof extra.executionProfile === 'string' ? extra.executionProfile : undefined;
  return {
    kind: result.kind,
    durationMs: result.durationMs,
    pointerCount: result.pointerCount,
    from: result.from,
    to: result.to,
    ...(result.backendResult ?? {}),
    ...extra,
    ...(executionProfile
      ? {
          timing: {
            executionProfile,
            gestureDurationMs: result.durationMs,
          },
        }
      : {}),
    message: result.message,
  };
}

function readSwipeInput(input: unknown): SwipePayload {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new AppError('INVALID_ARGS', 'swipe requires structured object input');
  }
  const record = input as Record<string, unknown>;
  if (record.durationMs !== undefined) {
    throw new AppError(
      'INVALID_ARGS',
      'swipe does not accept durationMs; use gesture pan for timed movement',
    );
  }
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

async function runSwipeRepetitions(
  runtime: ReturnType<typeof createInteractionRuntime>,
  params: InteractionHandlerParams,
  input: SwipePayload,
  count: number,
  pauseMs: number,
  pattern: 'one-way' | 'ping-pong',
) {
  let result: Awaited<ReturnType<typeof runtime.interactions.gesture>> | undefined;
  for (let index = 0; index < count; index += 1) {
    const normalized = normalizePublicSwipeMotion(swipeMotionAtIndex(input, pattern, index));
    result = await runtime.interactions.gesture({
      session: params.sessionName,
      requestId: params.req.meta?.requestId,
      gesture: normalized.gesture,
    });
    if (pauseMs > 0 && index + 1 < count) await sleep(pauseMs);
  }
  if (!result) throw new Error('Swipe orchestration did not execute a gesture.');
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

function gestureReplayFlags(
  input: GesturePayload,
  flags: InteractionHandlerParams['req']['flags'],
): InteractionHandlerParams['req']['flags'] {
  if (input.kind !== 'pan' || input.pointerCount === undefined) return flags;
  return { ...flags, pointerCount: input.pointerCount };
}
