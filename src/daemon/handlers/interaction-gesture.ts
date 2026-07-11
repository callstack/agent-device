import { readGesturePayload, type GesturePayload } from '../../contracts/gesture-input.ts';
import type { GestureSemanticInput } from '../../contracts/gesture-plan-types.ts';
import { requireGestureSupported } from '../../core/gesture-capabilities.ts';
import { normalizeError } from '../../kernel/errors.ts';
import type { DaemonResponse } from '../types.ts';
import { ensureAndroidBlockingSystemDialogReady } from '../android-system-dialog.ts';
import type { InteractionHandlerParams } from './interaction-common.ts';
import { finalizeTouchInteraction } from './interaction-common.ts';
import { createInteractionRuntime } from './interaction-runtime.ts';
import type { CaptureSnapshotForSession } from './interaction-snapshot.ts';
import { noActiveSessionError } from './response.ts';
import { isActiveProviderDevice } from '../../provider-device-runtime.ts';

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
    const semantic = toGestureSemanticInput(input);
    requireGestureSupported(semantic, session.device);
    const readiness = isActiveProviderDevice(session.device)
      ? ({ status: 'clear' } as const)
      : await ensureAndroidBlockingSystemDialogReady({
          session,
          command: 'gesture',
          phase: 'before-command',
        });
    const runtime = createInteractionRuntime(params);
    const result = await runtime.interactions.gesture({
      session: params.sessionName,
      requestId: params.req.meta?.requestId,
      gesture: semantic,
    });
    if (!isActiveProviderDevice(session.device)) {
      await ensureAndroidBlockingSystemDialogReady({
        session,
        command: 'gesture',
        phase: 'after-command',
      });
    }
    const responseData = buildGestureResponse(input, result);
    if (readiness.status === 'recovered') responseData.warning = readiness.warning;
    const positionals = gesturePositionals(input);
    const flags = gestureReplayFlags(input, params.req.flags);
    return finalizeTouchInteraction({
      session,
      sessionStore: params.sessionStore,
      command: 'gesture',
      actionCommand: gestureActionCommand(input),
      positionals,
      flags,
      result: responseData,
      responseData,
      actionStartedAt: startedAt,
      actionFinishedAt: Date.now(),
    });
  } catch (error) {
    return { ok: false, error: normalizeError(error) };
  }
}

function gestureReplayFlags(
  input: GesturePayload,
  flags: InteractionHandlerParams['req']['flags'],
): InteractionHandlerParams['req']['flags'] {
  if (input.kind !== 'pan' || input.pointerCount === undefined) return flags;
  return { ...flags, pointerCount: input.pointerCount };
}

function readDaemonGestureInput(params: InteractionHandlerParams): GesturePayload {
  return readGesturePayload(params.req.input);
}

function toGestureSemanticInput(input: GesturePayload): GestureSemanticInput {
  switch (input.kind) {
    case 'pan':
      return {
        intent: input.kind,
        origin: input.origin,
        delta: input.delta,
        pointerCount: input.pointerCount,
        durationMs: input.durationMs,
      };
    case 'fling':
      return {
        intent: input.kind,
        direction: input.direction,
        origin: input.origin,
        distance: input.distance,
        durationMs: input.durationMs,
      };
    case 'swipe':
      return { intent: input.kind, preset: input.preset, durationMs: input.durationMs };
    case 'pinch':
      return { intent: input.kind, origin: input.origin, scale: input.scale };
    case 'rotate':
      return {
        intent: input.kind,
        origin: input.origin,
        degrees: input.degrees,
        velocity: input.velocity,
      };
    case 'transform':
      return {
        intent: input.kind,
        origin: input.origin,
        delta: input.delta,
        scale: input.scale,
        degrees: input.degrees,
        durationMs: input.durationMs,
      };
  }
}

type GestureRuntimeResult = Awaited<
  ReturnType<ReturnType<typeof createInteractionRuntime>['interactions']['gesture']>
>;

function buildGestureResponse(
  input: GesturePayload,
  result: GestureRuntimeResult,
): Record<string, unknown> {
  const backend = result.backendResult ?? {};
  switch (input.kind) {
    case 'pan':
      return buildPanResponse(input, result, backend);
    case 'fling':
      return buildFlingResponse(input, result, backend);
    case 'swipe':
      return buildSwipeResponse(input, result, backend);
    case 'pinch':
      return buildPinchResponse(input, result, backend);
    case 'rotate':
      return buildRotateResponse(input, result, backend);
    case 'transform':
      return buildTransformResponse(input, result, backend);
  }
}

function buildPanResponse(
  input: Extract<GesturePayload, { kind: 'pan' }>,
  result: GestureRuntimeResult,
  backend: Record<string, unknown>,
): Record<string, unknown> {
  return {
    x: input.origin.x,
    y: input.origin.y,
    dx: input.delta.x,
    dy: input.delta.y,
    x2: input.origin.x + input.delta.x,
    y2: input.origin.y + input.delta.y,
    durationMs: result.durationMs,
    ...(input.pointerCount !== undefined ? { pointerCount: input.pointerCount } : {}),
    ...backend,
    message: result.message,
  };
}

function buildFlingResponse(
  input: Extract<GesturePayload, { kind: 'fling' }>,
  result: GestureRuntimeResult,
  backend: Record<string, unknown>,
): Record<string, unknown> {
  const from = result.from ?? input.origin;
  const to = result.to ?? input.origin;
  return {
    direction: input.direction,
    x: from.x,
    y: from.y,
    x2: to.x,
    y2: to.y,
    distance: input.distance ?? 180,
    durationMs: result.durationMs,
    ...backend,
    message: result.message,
  };
}

function buildSwipeResponse(
  input: Extract<GesturePayload, { kind: 'swipe' }>,
  result: GestureRuntimeResult,
  backend: Record<string, unknown>,
): Record<string, unknown> {
  return {
    x1: result.from?.x,
    y1: result.from?.y,
    x2: result.to?.x,
    y2: result.to?.y,
    preset: input.preset,
    durationMs: result.durationMs,
    effectiveDurationMs: result.durationMs,
    timingMode: 'direct',
    count: 1,
    pauseMs: 0,
    pattern: 'one-way',
    ...backend,
    message: result.message,
  };
}

function buildPinchResponse(
  input: Extract<GesturePayload, { kind: 'pinch' }>,
  result: GestureRuntimeResult,
  backend: Record<string, unknown>,
): Record<string, unknown> {
  return {
    scale: input.scale,
    x: input.origin?.x,
    y: input.origin?.y,
    ...backend,
    message: result.message,
  };
}

function buildRotateResponse(
  input: Extract<GesturePayload, { kind: 'rotate' }>,
  result: GestureRuntimeResult,
  backend: Record<string, unknown>,
): Record<string, unknown> {
  return {
    degrees: input.degrees,
    ...(input.origin ? { x: input.origin.x, y: input.origin.y } : {}),
    velocity: Math.abs(input.velocity ?? 1) * (input.degrees >= 0 ? 1 : -1),
    ...backend,
    message: result.message,
  };
}

function buildTransformResponse(
  input: Extract<GesturePayload, { kind: 'transform' }>,
  result: GestureRuntimeResult,
  backend: Record<string, unknown>,
): Record<string, unknown> {
  return {
    x: input.origin.x,
    y: input.origin.y,
    dx: input.delta.x,
    dy: input.delta.y,
    scale: input.scale,
    degrees: input.degrees,
    durationMs: input.durationMs,
    ...backend,
    message: result.message,
  };
}

function gestureActionCommand(input: GesturePayload): string {
  return input.kind;
}

function gesturePositionals(input: GesturePayload): string[] {
  switch (input.kind) {
    case 'pan':
      return panPositionals(input);
    case 'fling':
      return flingPositionals(input);
    case 'swipe':
      return compactPositionals([input.kind, input.preset, input.durationMs]);
    case 'pinch':
      return compactPositionals([input.kind, input.scale, input.origin?.x, input.origin?.y]);
    case 'rotate':
      return rotatePositionals(input);
    case 'transform':
      return transformPositionals(input);
  }
}

function panPositionals(input: Extract<GesturePayload, { kind: 'pan' }>): string[] {
  return compactPositionals([
    input.kind,
    input.origin.x,
    input.origin.y,
    input.delta.x,
    input.delta.y,
    input.durationMs,
  ]);
}

function flingPositionals(input: Extract<GesturePayload, { kind: 'fling' }>): string[] {
  const distance = input.durationMs === undefined ? input.distance : (input.distance ?? 180);
  return compactPositionals([
    input.kind,
    input.direction,
    input.origin.x,
    input.origin.y,
    distance,
    input.durationMs,
  ]);
}

function rotatePositionals(input: Extract<GesturePayload, { kind: 'rotate' }>): string[] {
  const center = input.origin ?? (input.velocity === undefined ? undefined : { x: 0, y: 0 });
  return compactPositionals([input.kind, input.degrees, center?.x, center?.y, input.velocity]);
}

function transformPositionals(input: Extract<GesturePayload, { kind: 'transform' }>): string[] {
  return compactPositionals([
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

function compactPositionals(values: Array<string | number | undefined>): string[] {
  return values.filter((value): value is string | number => value !== undefined).map(String);
}
