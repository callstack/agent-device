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
import { isActiveProviderDevice } from '../../provider-device-runtime.ts';
import { sleep } from '../../utils/timeouts.ts';
import type { DaemonResponse } from '../types.ts';
import { ensureAndroidBlockingSystemDialogReady } from '../android-system-dialog.ts';
import type { InteractionHandlerParams } from './interaction-common.ts';
import { finalizeTouchInteraction } from './interaction-common.ts';
import { createInteractionRuntime } from './interaction-runtime.ts';
import type { CaptureSnapshotForSession } from './interaction-snapshot.ts';
import { noActiveSessionError } from './response.ts';

export async function dispatchGestureViaRuntime(
  params: InteractionHandlerParams & {
    captureSnapshotForSession: CaptureSnapshotForSession;
  },
): Promise<DaemonResponse> {
  const session = params.sessionStore.get(params.sessionName);
  if (!session) return noActiveSessionError();
  const startedAt = Date.now();
  try {
    const input = readGesturePayload(params.req.input);
    const normalized = normalizePublicGesture(input);
    requireGestureSupported(normalized.gesture, session.device);
    const providerDevice = isActiveProviderDevice(session.device);
    const readiness = providerDevice
      ? ({ status: 'clear' } as const)
      : await ensureAndroidBlockingSystemDialogReady({
          session,
          command: 'gesture',
          phase: 'before-command',
        });
    const result = await createInteractionRuntime(params).interactions.gesture({
      session: params.sessionName,
      requestId: params.req.meta?.requestId,
      gesture: normalized.gesture,
    });
    if (!providerDevice) {
      await ensureAndroidBlockingSystemDialogReady({
        session,
        command: 'gesture',
        phase: 'after-command',
      });
    }
    const responseData: Record<string, unknown> = {
      kind: result.kind,
      durationMs: result.durationMs,
      pointerCount: result.pointerCount,
      from: result.from,
      to: result.to,
      ...(result.backendResult ?? {}),
      ...(normalized.deprecations.length > 0 ? { deprecations: normalized.deprecations } : {}),
      message: result.message,
    };
    if (readiness.status === 'recovered') responseData.warning = readiness.warning;
    return finalizeTouchInteraction({
      session,
      sessionStore: params.sessionStore,
      command: 'gesture',
      actionCommand: 'gesture',
      positionals: gesturePayloadToPositionals(input),
      flags: gestureReplayFlags(input, params.req.flags),
      result: {
        ...responseData,
        ...(input.kind === 'pinch' ? { scale: input.scale } : {}),
      },
      responseData,
      actionStartedAt: startedAt,
      actionFinishedAt: Date.now(),
    });
  } catch (error) {
    return { ok: false, error: normalizeError(error) };
  }
}

export async function dispatchSwipeViaRuntime(
  params: InteractionHandlerParams & {
    captureSnapshotForSession: CaptureSnapshotForSession;
  },
): Promise<DaemonResponse> {
  const session = params.sessionStore.get(params.sessionName);
  if (!session) return noActiveSessionError();
  const startedAt = Date.now();
  try {
    const input = readSwipeInput(params.req.input);
    requireGestureSupported(normalizePublicSwipeMotion(input).gesture, session.device);
    const count = input.count ?? 1;
    const pauseMs = input.pauseMs ?? 0;
    const pattern = input.pattern ?? 'one-way';
    const providerDevice = isActiveProviderDevice(session.device);
    const readiness = providerDevice
      ? ({ status: 'clear' } as const)
      : await ensureAndroidBlockingSystemDialogReady({
          session,
          command: 'swipe',
          phase: 'before-command',
        });
    const runtime = createInteractionRuntime(params);
    const result = await runSwipeRepetitions(runtime, params, input, count, pauseMs, pattern);
    if (!providerDevice) {
      await ensureAndroidBlockingSystemDialogReady({
        session,
        command: 'swipe',
        phase: 'after-command',
      });
    }
    const responseData: Record<string, unknown> = {
      kind: result.kind,
      durationMs: result.durationMs,
      pointerCount: result.pointerCount,
      from: result.from,
      to: result.to,
      count,
      pauseMs,
      pattern,
      ...(result.backendResult ?? {}),
      ...(result.deprecations ? { deprecations: result.deprecations } : {}),
      message: result.message,
    };
    if (readiness.status === 'recovered') responseData.warning = readiness.warning;
    return finalizeTouchInteraction({
      session,
      sessionStore: params.sessionStore,
      command: 'swipe',
      actionCommand: 'swipe',
      positionals: swipeReplayPositionals(input),
      flags: params.req.flags,
      result: responseData,
      responseData,
      actionStartedAt: startedAt,
      actionFinishedAt: Date.now(),
    });
  } catch (error) {
    return { ok: false, error: normalizeError(error) };
  }
}

function readSwipeInput(input: unknown): SwipePayload {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new AppError('INVALID_ARGS', 'swipe requires structured object input');
  }
  const record = input as Record<string, unknown>;
  const pattern = record.pattern;
  if (pattern !== undefined && pattern !== 'one-way' && pattern !== 'ping-pong') {
    throw new AppError('INVALID_ARGS', 'swipe pattern must be one-way or ping-pong');
  }
  const payload: SwipePayload = {
    from: readSwipePoint(record.from, 'swipe from'),
    to: readSwipePoint(record.to, 'swipe to'),
    durationMs: readOptionalInteger(record, 'durationMs', { min: 16, max: 10_000 }),
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
  const gestureDurationMs = input.durationMs ?? GESTURE_FLING_DURATION_MS;
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
      hint: 'Reduce --count, --pause-ms, or the deprecated swipe duration.',
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
  return [
    String(input.from.x),
    String(input.from.y),
    String(input.to.x),
    String(input.to.y),
    ...(input.durationMs === undefined ? [] : [String(input.durationMs)]),
  ];
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
  const deprecations = normalizePublicSwipeMotion(input).deprecations;
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
  return {
    ...result,
    ...(deprecations.length > 0 ? { deprecations } : {}),
  };
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
