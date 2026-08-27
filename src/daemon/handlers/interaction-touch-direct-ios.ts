import type { GestureReferenceFrame } from '@agent-device/contracts/scroll-gesture';
import { normalizeError } from '@agent-device/kernel/errors';
import { emitDiagnostic } from '@agent-device/host-kit/diagnostics';
import {
  isDirectIosSelectorFallbackError,
  type DirectIosSelectorTarget,
} from '../direct-ios-selector.ts';
import { expireRefFrame } from '../ref-frame.ts';
import type { DaemonResponse, SessionState } from '../types.ts';
import { finalizeTouchInteraction, type InteractionHandlerParams } from './interaction-common.ts';
import { corroborateIosTapFailure } from './interaction-ios-tap-outcome.ts';
import type { CaptureSnapshotForSession } from './interaction-snapshot.ts';
import type { BoundTouchExecutor } from '../touch-runtime.ts';
import {
  buildCorroboratedTapResponseData,
  buildInteractionResponseData,
  maestroFallbackDisclosure,
  pointPositionals,
  readInteractionResponseDataTransformCommand,
  transformTouchResponseData,
} from './interaction-touch-response.ts';

/**
 * How the Maestro-compatible direct iOS selector route dispatches or
 * corroborates its own failure. Eligibility — the narrow gate that decides
 * whether this path may run at all — lives in
 * interaction-touch-direct-ios-eligibility.ts.
 */

export async function dispatchDirectIosSelectorTap(
  params: InteractionHandlerParams & { captureSnapshotForSession: CaptureSnapshotForSession },
  session: SessionState,
  selector: DirectIosSelectorTarget,
  tapElementSelector: NonNullable<BoundTouchExecutor['tapElementSelector']>,
): Promise<DaemonResponse | null> {
  const handlerParams = params;
  const extra = { selector: selector.raw };
  const actionStartedAt = Date.now();
  // ADR 0014 side-effect seam: the direct iOS selector path fuses its final
  // status/target check and mutation into one runner request and consumes no
  // ref, so dispatching that fused request is the conservative seam. A later
  // not-found/timeout is post-seam and does not restore the frame.
  expireRefFrame(session);
  try {
    const data = (await tapElementSelector(selector)) ?? {};
    const actionFinishedAt = Date.now();
    const point = readPointFromDirectSelectorTapResult(data);
    const publicData = transformTouchResponseData({
      command: readInteractionResponseDataTransformCommand(handlerParams.req.command, 'press'),
      flags: handlerParams.req.flags,
      data,
    });
    const maestroFallback = maestroFallbackDisclosure(
      selector.allowNonHittableCoordinateFallback === true,
      data,
    );
    const { result, responseData } = buildInteractionResponseData({
      source: {
        kind: 'runner-payload',
        targetKind: 'selector',
        data,
        publicData,
        point,
        dispatchPath: maestroFallback.used
          ? 'maestro-non-hittable-fallback'
          : 'maestro-direct-selector',
      },
      referenceFrame: readReferenceFrameFromDirectSelectorTapResult(data),
      extra: {
        ...extra,
        ...maestroFallback.extra,
      },
    });
    return finalizeTouchInteraction({
      session,
      sessionStore: handlerParams.sessionStore,
      command: handlerParams.req.command,
      positionals: handlerParams.req.positionals ?? [],
      retryPositionals: pointPositionals(point),
      flags: handlerParams.req.flags,
      result,
      responseData,
      actionStartedAt,
      actionFinishedAt,
    });
  } catch (error) {
    const corroboratedResponse = await buildDirectIosCorroboratedResponse({
      error,
      handlerParams,
      session,
      extra,
      positionals: [],
      actionStartedAt,
    });
    if (corroboratedResponse) return corroboratedResponse;
    // ADR 0011 delegation-on-error: semantic runner failures fall back to the
    // tree-based runtime path — except for Maestro replay dispatches, whose
    // runner-native error shapes must be preserved.
    const fallback = isDirectIosSelectorFallbackError(error, {
      delegateSemanticFailures: selector.allowNonHittableCoordinateFallback !== true,
    });
    if (!fallback) {
      return { ok: false, error: normalizeError(error) };
    }
    emitDiagnostic({
      level: 'debug',
      phase: 'ios_direct_selector_tap_fallback',
      data: {
        selector: selector.raw,
        error: error instanceof Error ? error.message : String(error),
      },
    });
    return null;
  }
}

async function buildDirectIosCorroboratedResponse(params: {
  error: unknown;
  handlerParams: InteractionHandlerParams & {
    captureSnapshotForSession: CaptureSnapshotForSession;
  };
  session: SessionState;
  extra: Record<string, unknown>;
  positionals: string[];
  actionStartedAt: number;
}): Promise<DaemonResponse | undefined> {
  const { error, handlerParams, session, extra, positionals, actionStartedAt } = params;
  const corroboration = await corroborateIosTapFailure({
    error,
    command: handlerParams.req.command,
    requestId: handlerParams.req.meta?.requestId,
    flags: handlerParams.req.flags,
    session,
    sessionStore: handlerParams.sessionStore,
    contextFromFlags: handlerParams.contextFromFlags,
    captureSnapshotForSession: handlerParams.captureSnapshotForSession,
  });
  if (!corroboration) return undefined;

  const { result, responseData } = buildCorroboratedTapResponseData({
    targetKind: 'selector',
    warning: corroboration.warning,
    resolution: { source: 'direct-ios', kind: 'not-observed' },
    extra,
  });
  return finalizeTouchInteraction({
    session,
    sessionStore: handlerParams.sessionStore,
    command: handlerParams.req.command,
    positionals: handlerParams.req.positionals ?? positionals,
    flags: handlerParams.req.flags,
    result,
    responseData,
    scheduleInteractionOutcomeRetry: false,
    actionStartedAt,
    actionFinishedAt: Date.now(),
  });
}

function readPointFromDirectSelectorTapResult(data: Record<string, unknown>): {
  x: number;
  y: number;
} {
  const x = typeof data.x === 'number' ? data.x : undefined;
  const y = typeof data.y === 'number' ? data.y : undefined;
  if (x !== undefined && y !== undefined) {
    return { x, y };
  }
  return { x: 0, y: 0 };
}

function readReferenceFrameFromDirectSelectorTapResult(
  data: Record<string, unknown>,
): GestureReferenceFrame | undefined {
  return typeof data.referenceWidth === 'number' && typeof data.referenceHeight === 'number'
    ? { referenceWidth: data.referenceWidth, referenceHeight: data.referenceHeight }
    : undefined;
}
