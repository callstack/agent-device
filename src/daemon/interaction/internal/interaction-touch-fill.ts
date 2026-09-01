import type { CommandFlags } from '@agent-device/contracts/command';
import type { FillCommandResult, InteractionTarget } from '@agent-device/contracts/interaction';
import { issueSettleRefs, resolveRefStalenessWarning } from '../../session-snapshot.ts';
import { readRefMutationFrame } from '../../ref-frame.ts';
import type { DaemonResponse, SessionState } from '../../types.ts';
import { isSessionRecording } from '../../session-script-publication-capability.ts';
import { assertRecordedFillParameterization } from './interaction-recorded-input.ts';
import { readSettleRequest, settleFlagGuardResponse } from './interaction-flags.ts';
import { refMutationAdmissionResponse } from './interaction-ref-policy.ts';
import type {
  CaptureSnapshotForSession,
  InteractionRouteInput,
  RefSnapshotFlagGuardResponse,
} from './types.ts';
import { refreshAndroidRefSnapshotIfFreshnessActive } from './interaction-touch-android-freshness.ts';
import { unsupportedMacOsDesktopSurfaceInteraction } from './interaction-touch-policy.ts';
import { readSnapshotNodesReferenceFrame } from '../../touch-reference-frame.ts';
import {
  buildInteractionResponseData,
  maestroFallbackDisclosure,
  transformTouchResponseData,
  type InteractionResponsePayloads,
} from './interaction-touch-response.ts';
import { dispatchRuntimeInteraction } from './interaction-touch-runtime.ts';
import { parseFillTarget } from './interaction-touch-targets.ts';
import { noActiveSessionError } from '../../response.ts';
import { prepareTouchDispatch } from './interaction-touch-prepare.ts';

/**
 * How `fill` is admitted, parameterized, executed, and projected: surface and
 * capability policy, recorded-parameter assertion, the `@ref` preamble it
 * shares in shape with press, and its response payloads.
 */

export async function dispatchFillViaRuntime(
  params: InteractionRouteInput & {
    captureSnapshotForSession: CaptureSnapshotForSession;
    refSnapshotFlagGuardResponse: RefSnapshotFlagGuardResponse;
  },
): Promise<DaemonResponse> {
  const { req, sessionName, sessionStore } = params;
  const session = sessionStore.get(sessionName);
  if (session) {
    const unsupportedSurfaceResponse = unsupportedMacOsDesktopSurfaceInteraction(session, 'fill');
    if (unsupportedSurfaceResponse) return unsupportedSurfaceResponse;
  }
  if (!session) return noActiveSessionError();
  const parsedTarget = parseFillTarget(req.positionals ?? []);
  if (!parsedTarget.ok) return parsedTarget.response;
  const prepared = await prepareTouchDispatch(
    params,
    session,
    'fill',
    parsedTarget.target.kind !== 'point',
  );
  if (!prepared.ok) return prepared.response;
  const { touchExecutor } = prepared;
  assertRecordedFillParameterization({
    flags: req.flags,
    replayPlanStep: req.internal?.replayPlanStep === true,
    isSessionRecording: isSessionRecording(session),
  });
  const invalidSettleFlags = settleFlagGuardResponse('fill', req.flags);
  if (invalidSettleFlags) return invalidSettleFlags;

  const refPreamble = await prepareFillRefTarget(
    params,
    session,
    parsedTarget.target,
    parsedTarget.refGeneration,
  );
  if (refPreamble.response) return refPreamble.response;
  const { staleRefsWarning } = refPreamble;
  const replayTargetGuard = req.internal?.replayTargetGuard;

  return await dispatchRuntimeInteraction(params, {
    touchExecutor,
    refContext:
      parsedTarget.target.kind === 'ref' && req.internal?.findResolvedTarget === undefined
        ? {
            ref: parsedTarget.target.ref,
            mintedGeneration: parsedTarget.refGeneration,
            staleRefsWarning,
          }
        : undefined,
    run: async (runtime) =>
      await runtime.interactions.fill(parsedTarget.target, parsedTarget.text, {
        session: sessionName,
        requestId: req.meta?.requestId,
        delayMs: req.flags?.delayMs,
        allowNonHittableCoordinateFallback: req.flags?.maestro?.allowNonHittableCoordinateFallback,
        verify: req.flags?.verify,
        settle: readSettleRequest(req.flags),
        expectedResolvedTarget: replayTargetGuard,
        preresolvedTarget: req.internal?.findResolvedTarget,
      }),
    buildPayloads: (result) =>
      buildFillResponsePayloads({
        session,
        result,
        text: parsedTarget.text,
        flags: req.flags,
        staleRefsWarning,
      }),
  });
}

// The fill @ref preamble shared with the press path's shape: read staleness
// relative to what the client knew BEFORE any internal recapture, validate
// @ref-incompatible flags, enforce iOS mutation freshness, and run the Android
// freshness refresh.
async function prepareFillRefTarget(
  params: InteractionRouteInput & {
    captureSnapshotForSession: CaptureSnapshotForSession;
    refSnapshotFlagGuardResponse: RefSnapshotFlagGuardResponse;
  },
  session: SessionState,
  target: InteractionTarget,
  refGeneration: number | undefined,
): Promise<{ response?: DaemonResponse; staleRefsWarning?: string }> {
  if (target.kind !== 'ref') return {};
  // A mutating `find`'s internal dispatch supplies a locator-minted ref, so the
  // public response must not claim the caller consumed a stale `@ref` (ADR 0014).
  const staleRefsWarning =
    params.req.internal?.findResolvedTarget !== undefined
      ? undefined
      : resolveRefStalenessWarning({
          session,
          ref: target.ref,
          mintedGeneration: refGeneration,
        });
  const invalidRefFlagsResponse = params.refSnapshotFlagGuardResponse('fill', params.req.flags);
  if (invalidRefFlagsResponse) return { response: invalidRefFlagsResponse, staleRefsWarning };
  const admissionResponse = params.req.internal?.findResolvedTarget
    ? null
    : refMutationAdmissionResponse({
        ref: target.ref,
        mintedGeneration: refGeneration,
        staleRefsWarning,
        frame: readRefMutationFrame({
          session,
          ref: target.ref,
          mintedGeneration: refGeneration,
        }),
      });
  if (admissionResponse) return { response: admissionResponse, staleRefsWarning };
  await refreshAndroidRefSnapshotIfFreshnessActive(params, session);
  return { staleRefsWarning };
}

function buildFillResponsePayloads(params: {
  session: SessionState;
  result: FillCommandResult;
  text: string;
  flags: CommandFlags | undefined;
  staleRefsWarning: string | undefined;
}): InteractionResponsePayloads {
  const { session, result } = params;
  const maestroFallback = maestroFallbackDisclosure(
    params.flags?.maestro?.allowNonHittableCoordinateFallback === true,
    result.backendResult,
  );
  const referenceFrame =
    result.kind === 'point'
      ? undefined
      : readSnapshotNodesReferenceFrame(session.snapshot?.nodes ?? []);
  return buildInteractionResponseData({
    source: {
      kind: 'runtime',
      result,
      publicData: transformTouchResponseData({
        command: 'fill',
        flags: params.flags,
        data: result.backendResult,
      }),
      ...(maestroFallback.used ? { dispatchPath: 'maestro-non-hittable-fallback' as const } : {}),
    },
    referenceFrame,
    extra: { text: params.text, ...maestroFallback.extra },
    staleRefsWarning: params.staleRefsWarning,
    settleRefsGeneration: issueSettleRefs(session, result.settle),
  });
}
