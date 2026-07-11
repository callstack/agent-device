import { readGesturePayload, type GesturePayload } from '../../contracts/gesture-input.ts';
import {
  gesturePayloadFromLegacyPositionals,
  normalizePublicGesture,
  normalizePublicSwipeMotion,
} from '../../contracts/gesture-normalization.ts';
import { requireGestureSupported } from '../../core/capabilities.ts';
import { normalizeError } from '../../kernel/errors.ts';
import { isActiveProviderDevice } from '../../provider-device-runtime.ts';
import { readSwipeInput, type SwipeInput } from '../../commands/interaction/metadata.ts';
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
    const input = readDaemonGestureInput(params);
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
      positionals: gesturePositionals(input),
      flags: gestureReplayFlags(input, params.req.flags),
      result: responseData,
      responseData,
      actionStartedAt: startedAt,
      actionFinishedAt: Date.now(),
    });
  } catch (error) {
    return { ok: false, error: normalizeError(error) };
  }
}

/** `.ad` actions retain positional syntax; all public command clients send structured input. */
function readDaemonGestureInput(params: InteractionHandlerParams): GesturePayload {
  if (params.req.input !== undefined) return readGesturePayload(params.req.input);
  return gesturePayloadFromLegacyPositionals(
    params.req.positionals ?? [],
    params.req.flags?.pointerCount,
  );
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
    const input = readDaemonSwipeInput(params);
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
      positionals: params.req.positionals ?? [],
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

function readDaemonSwipeInput(params: InteractionHandlerParams): SwipeInput {
  const structured = params.req.input;
  if (isStructuredSwipeInput(structured)) return readSwipeInput(structured);
  return readLegacySwipeInput(params);
}

function isStructuredSwipeInput(input: unknown): input is Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return false;
  return 'from' in input && 'to' in input;
}

function readLegacySwipeInput(params: InteractionHandlerParams): SwipeInput {
  const [x1, y1, x2, y2, durationMs] = params.req.positionals ?? [];
  const duration = durationMs === undefined ? {} : { durationMs: Number(durationMs) };
  return readSwipeInput({
    from: { x: Number(x1), y: Number(y1) },
    to: { x: Number(x2), y: Number(y2) },
    ...duration,
    count: params.req.flags?.count,
    pauseMs: params.req.flags?.pauseMs,
    pattern: params.req.flags?.pattern,
  });
}

async function runSwipeRepetitions(
  runtime: ReturnType<typeof createInteractionRuntime>,
  params: InteractionHandlerParams,
  input: SwipeInput,
  count: number,
  pauseMs: number,
  pattern: 'one-way' | 'ping-pong',
) {
  let result: Awaited<ReturnType<typeof runtime.interactions.swipe>> | undefined;
  for (let index = 0; index < count; index += 1) {
    const reverse = pattern === 'ping-pong' && index % 2 === 1;
    result = await runtime.interactions.swipe({
      session: params.sessionName,
      requestId: params.req.meta?.requestId,
      from: reverse ? input.to : input.from,
      to: reverse ? input.from : input.to,
      durationMs: input.durationMs,
    });
    if (pauseMs > 0 && index + 1 < count) await sleep(pauseMs);
  }
  if (!result) throw new Error('Swipe orchestration did not execute a gesture.');
  return result;
}

function gestureReplayFlags(
  input: GesturePayload,
  flags: InteractionHandlerParams['req']['flags'],
): InteractionHandlerParams['req']['flags'] {
  if (input.kind !== 'pan' || input.pointerCount === undefined) return flags;
  return { ...flags, pointerCount: input.pointerCount };
}

function gesturePositionals(input: GesturePayload): string[] {
  switch (input.kind) {
    case 'pan':
      return panPositionals(input);
    case 'fling':
      return flingPositionals(input);
    case 'swipe':
      return compact([input.kind, input.preset, input.durationMs]);
    case 'pinch':
      return compact([input.kind, input.scale, input.origin?.x, input.origin?.y]);
    case 'rotate':
      return rotatePositionals(input);
    case 'transform':
      return transformPositionals(input);
  }
}

function panPositionals(input: Extract<GesturePayload, { kind: 'pan' }>): string[] {
  return compact([
    input.kind,
    input.origin.x,
    input.origin.y,
    input.delta.x,
    input.delta.y,
    input.durationMs,
  ]);
}

function flingPositionals(input: Extract<GesturePayload, { kind: 'fling' }>): string[] {
  return compact([
    input.kind,
    input.direction,
    input.origin.x,
    input.origin.y,
    input.distance,
    input.durationMs,
  ]);
}

function rotatePositionals(input: Extract<GesturePayload, { kind: 'rotate' }>): string[] {
  return compact([input.kind, input.degrees, input.origin?.x, input.origin?.y, input.velocity]);
}

function transformPositionals(input: Extract<GesturePayload, { kind: 'transform' }>): string[] {
  return compact([
    input.kind,
    input.origin.x,
    input.origin.y,
    input.delta.x,
    input.delta.y,
    input.scale,
    input.degrees,
    input.durationMs,
  ]);
}

function compact(values: Array<string | number | undefined>): string[] {
  return values.filter((value): value is string | number => value !== undefined).map(String);
}
