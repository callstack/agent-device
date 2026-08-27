import type {
  FillCommandResult,
  InteractionTarget,
  LongPressCommandResult,
  PressCommandResult,
  ResolvedInteractionTarget,
} from '@agent-device/contracts/interaction';
import type { GestureReferenceFrame } from '@agent-device/contracts/scroll-gesture';
import { asAppError, normalizeError } from '@agent-device/kernel/errors';
import { readResolvedInteractionTarget } from '../../core/interaction-outcome.ts';
import { isSessionRecording } from '../session-script-publication-capability.ts';
import type { DaemonResponse, SessionState } from '../types.ts';
import { publishInteractionAmbiguityCandidates } from './interaction-ambiguity-publication.ts';
import { isAndroidEscapeError } from './interaction-android-escape.ts';
import { finalizeTouchInteraction, type InteractionHandlerParams } from './interaction-common.ts';
import { corroborateIosTapFailure, interactionTargetExtra } from './interaction-ios-tap-outcome.ts';
import { createInteractionRuntime } from './interaction-runtime.ts';
import type { CaptureSnapshotForSession } from './interaction-snapshot.ts';
import {
  runWithAndroidDialogReadinessCheck,
  type RefAdmissionContext,
} from './interaction-touch-android-readiness.ts';
import { readSnapshotNodesReferenceFrame } from './interaction-touch-reference-frame.ts';
import {
  buildCorroboratedTapResponseData,
  buildInteractionResponseData,
  pointPositionals,
  type InteractionResponsePayloads,
} from './interaction-touch-response.ts';
import { noActiveSessionError } from './response.ts';
import type { BoundTouchExecutor } from '../touch-runtime.ts';

/**
 * The lifecycle every tree-resolved touch dispatch shares: Android readiness
 * around the device op, warning composition over the builder's payloads,
 * finalization, and the one same-scope iOS corroboration of a failed tap.
 */

export async function dispatchRuntimeInteraction<
  TResult extends PressCommandResult | FillCommandResult | LongPressCommandResult,
>(
  params: InteractionHandlerParams & {
    captureSnapshotForSession: CaptureSnapshotForSession;
  },
  options: {
    touchExecutor: BoundTouchExecutor;
    androidFreshnessBaseline?: SessionState['snapshot'];
    /**
     * Present when the action targets a `@ref`: if Android dialog recovery
     * expires the frame before dispatch, the action aborts through the shared
     * admission rejection built from this context.
     */
    refContext?: RefAdmissionContext;
    /** A failed local iOS tap may be corroborated against one same-scope capture. */
    iosTapCorroboration?: {
      target: InteractionTarget;
      extra: Record<string, unknown>;
    };
    run(runtime: ReturnType<typeof createInteractionRuntime>): Promise<TResult>;
    /** May return a warning to append to the successful response (e.g. a pending Android permission dialog). */
    afterRun?(result: TResult): Promise<string | undefined>;
    buildPayloads(
      result: TResult,
    ): InteractionResponsePayloads | Promise<InteractionResponsePayloads>;
  },
): Promise<DaemonResponse> {
  const session = params.sessionStore.get(params.sessionName);
  if (!session) return noActiveSessionError();
  const runtime = createInteractionRuntime({ ...params, touchExecutor: options.touchExecutor });
  const actionStartedAt = Date.now();
  try {
    let afterRunWarning: string | undefined;
    const outcome = await runWithAndroidDialogReadinessCheck(
      session,
      params.req.command,
      { refContext: options.refContext },
      async () => {
        const result = await options.run(runtime);
        afterRunWarning = await options.afterRun?.(result);
        return result;
      },
      params.androidObservation,
    );
    if (outcome.aborted) return outcome.response;
    const { readiness, runtimeResult } = outcome;
    const actionFinishedAt = Date.now();
    const { result, responseData, recordedTarget } = await options.buildPayloads(runtimeResult);
    // Append, don't clobber — the builder may already carry a warning
    // (e.g. stale-refs, #1076).
    const appendedWarnings = [
      ...(readiness.status === 'recovered' ? [readiness.warning] : []),
      ...(afterRunWarning ? [afterRunWarning] : []),
    ];
    if (appendedWarnings.length > 0) {
      const warning = [
        ...(typeof responseData.warning === 'string' ? [responseData.warning] : []),
        ...appendedWarnings,
      ].join(' ');
      result.warning = warning;
      responseData.warning = warning;
    }
    return finalizeTouchInteraction({
      session,
      sessionStore: params.sessionStore,
      command: params.req.command,
      positionals: params.req.positionals ?? [],
      retryPositionals: retryPositionalsForRuntimeResult(params.req.command, runtimeResult),
      flags: params.req.flags,
      result,
      responseData,
      recordedTarget,
      actionStartedAt,
      actionFinishedAt,
      androidFreshnessBaseline: options.androidFreshnessBaseline,
    });
  } catch (error) {
    const appError = publishInteractionAmbiguityCandidates(session, asAppError(error));
    if (isAndroidEscapeError(appError)) throw appError;
    if (appError.code === 'AMBIGUOUS_MATCH') return appErrorResponse(appError);
    const corroboratedResponse = await buildRuntimeIosCorroboratedResponse({
      error: appError,
      handlerParams: params,
      session,
      target: options.iosTapCorroboration?.target,
      extra: options.iosTapCorroboration?.extra,
      actionStartedAt,
      androidFreshnessBaseline: options.androidFreshnessBaseline,
    });
    if (corroboratedResponse) return corroboratedResponse;
    return appErrorResponse(appError);
  }
}

async function buildRuntimeIosCorroboratedResponse(params: {
  error: unknown;
  handlerParams: InteractionHandlerParams & {
    captureSnapshotForSession: CaptureSnapshotForSession;
  };
  session: SessionState;
  target: InteractionTarget | undefined;
  extra: Record<string, unknown> | undefined;
  actionStartedAt: number;
  androidFreshnessBaseline: SessionState['snapshot'] | undefined;
}): Promise<DaemonResponse | undefined> {
  if (!params.target) return undefined;
  const resolvedTarget = readResolvedInteractionTarget(params.error);
  if (!resolvedTarget && isSessionRecording(params.session)) return undefined;
  const corroboration = await corroborateIosTapFailure({
    error: params.error,
    command: params.handlerParams.req.command,
    requestId: params.handlerParams.req.meta?.requestId,
    flags: params.handlerParams.req.flags,
    session: params.session,
    sessionStore: params.handlerParams.sessionStore,
    contextFromFlags: params.handlerParams.contextFromFlags,
    captureSnapshotForSession: params.handlerParams.captureSnapshotForSession,
  });
  if (!corroboration) return undefined;

  const payloads = buildIosCorroboratedPayloads({
    target: params.target,
    resolvedTarget,
    warning: corroboration.warning,
    referenceFrame: readSnapshotNodesReferenceFrame(params.session.snapshot?.nodes ?? []),
    extra: params.extra,
  });
  return finalizeTouchInteraction({
    session: params.session,
    sessionStore: params.handlerParams.sessionStore,
    command: params.handlerParams.req.command,
    positionals: params.handlerParams.req.positionals ?? [],
    flags: params.handlerParams.req.flags,
    result: payloads.result,
    responseData: payloads.responseData,
    recordedTarget: payloads.recordedTarget,
    scheduleInteractionOutcomeRetry: false,
    actionStartedAt: params.actionStartedAt,
    actionFinishedAt: Date.now(),
    androidFreshnessBaseline: params.androidFreshnessBaseline,
  });
}

function buildIosCorroboratedPayloads(params: {
  target: InteractionTarget;
  resolvedTarget: ResolvedInteractionTarget | undefined;
  warning: string;
  referenceFrame: GestureReferenceFrame | undefined;
  extra: Record<string, unknown> | undefined;
}): InteractionResponsePayloads {
  if (params.resolvedTarget) {
    return buildInteractionResponseData({
      source: {
        kind: 'runtime',
        result: { ...params.resolvedTarget, warning: params.warning },
      },
      referenceFrame: params.referenceFrame,
      extra: params.extra,
    });
  }
  return buildCorroboratedTapResponseData({
    targetKind: params.target.kind,
    point: pointFromInteractionTarget(params.target),
    warning: params.warning,
    referenceFrame: params.referenceFrame,
    extra: {
      ...interactionTargetExtra(params.target),
      ...(params.extra ?? {}),
    },
  });
}

function pointFromInteractionTarget(
  target: InteractionTarget,
): { x: number; y: number } | undefined {
  return target.kind === 'point' ? { x: target.x, y: target.y } : undefined;
}

function appErrorResponse(error: unknown): DaemonResponse {
  return { ok: false, error: normalizeError(error) };
}

function retryPositionalsForRuntimeResult(
  command: string,
  result: PressCommandResult | FillCommandResult | LongPressCommandResult,
): string[] | undefined {
  if (result.kind === 'ref' && !result.node) return undefined;
  if (command === 'click' || command === 'press') {
    if (!result.point) return undefined;
    return pointPositionals(result.point);
  }
  return undefined;
}
