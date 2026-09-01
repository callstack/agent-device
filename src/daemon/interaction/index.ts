import type { CommandFlags } from '@agent-device/contracts/command';
import type { AndroidObservationAdapter } from '@agent-device/contracts/android-observation';
import type { Rect, SnapshotState } from '@agent-device/kernel/snapshot';
import type { BindDeviceRuntime, InspectDeviceRuntimeFacts } from '../request-runtime-binding.ts';
import { buildRuntimeCaptureInput } from '../snapshot-runtime-capture-input.ts';
import { markDeferredInteractionOutcome } from '../deferred-interaction-outcome.ts';
import { expireRefFrame } from '../ref-frame.ts';
import { setSessionSnapshot } from '../session-snapshot.ts';
import { recordTouchVisualizationEvent } from '../recording-gestures.ts';
import { isSessionRecording } from '../session-script-publication-capability.ts';
import { createDaemonRuntimeSessionStore } from '../runtime-session.ts';
import { captureSnapshot as captureSnapshotThroughHandler } from '../handlers/snapshot-capture.ts';
import { NO_ACTIVE_SESSION_MESSAGE } from '../response.ts';
import { AppError as KernelAppError } from '@agent-device/kernel/errors';
import { buildAppleRunnerRequestOptions } from '../apple-runner-options.ts';
import { isLocalIosRunnerSession } from '../direct-ios-selector.ts';
import { confirmIosOffscreenTargetVisible } from '../offscreen-target-probe.ts';
import type { BoundGestureExecutor } from '../gesture-runtime.ts';
import type { BoundTouchExecutor } from '../touch-runtime.ts';
import { captureInteractionSnapshot } from './internal/interaction-snapshot.ts';
import { createInteractionRuntime as createInternalInteractionRuntime } from './internal/interaction-runtime.ts';
import { finalizeTouchInteraction as finalizeInternalInteraction } from './internal/interaction-common.ts';
import type { ContextFromFlags, InteractionSnapshotOptions } from './internal/types.ts';
import type { SessionStore } from '../session-store.ts';
import type { DaemonRequest, DaemonResponse, SessionState } from '../types.ts';

export type { ContextFromFlags } from './internal/types.ts';

export type InteractionRouteInput = {
  req: DaemonRequest;
  sessionName: string;
  logPath?: string;
  sessionStore: SessionStore;
  captureSnapshotForSession?: CaptureSnapshotForSession;
  contextFromFlags: ContextFromFlags;
  inspectFacts?: InspectDeviceRuntimeFacts;
  bindDevice?: BindDeviceRuntime;
  androidObservation?: AndroidObservationAdapter;
};

export type CaptureSnapshotForSession = (
  session: SessionState,
  flags: CommandFlags | undefined,
  sessionStore: SessionStore,
  contextFromFlags: ContextFromFlags,
  options: InteractionSnapshotOptions,
) => Promise<SnapshotState>;

export type RefSnapshotFlagGuardResponse = typeof refSnapshotFlagGuardResponse;

export { readTextForNode } from './internal/interaction-read.ts';
export { assertRecordedFillParameterization } from './internal/interaction-recorded-input.ts';
export { publishInteractionAmbiguityCandidates } from './internal/interaction-ambiguity-publication.ts';
export {
  assertRefMutationAdmitted,
  refMutationAdmissionResponse,
} from './internal/interaction-ref-policy.ts';
import {
  readSettleRequest,
  refSnapshotFlagGuardResponse,
  settleFlagGuardResponse,
} from './internal/interaction-flags.ts';

export { readSettleRequest, refSnapshotFlagGuardResponse, settleFlagGuardResponse };

export const captureSnapshotForSession: CaptureSnapshotForSession = async (
  session,
  flags,
  sessionStore,
  contextFromFlags,
  options,
) => {
  return await captureInteractionSnapshot({
    session,
    flags,
    contextFromFlags,
    options,
    capture: async ({ flags: effectiveFlags, options: captureOptions, context }) => {
      const { snapshot } = await captureSnapshotThroughHandler({
        device: session.device,
        session,
        flags: effectiveFlags,
        outPath: effectiveFlags.out,
        logPath: context.logPath ?? '',
        includeRects: captureOptions.includeRects,
        androidFreshnessMode: captureOptions.androidFreshnessMode,
        signal: captureOptions.signal,
        ...(captureOptions.boundCapture
          ? {
              captureData: async () =>
                await captureOptions.boundCapture!(
                  buildRuntimeCaptureInput({
                    flags: effectiveFlags,
                    session,
                    snapshotScope: effectiveFlags.snapshotScope,
                    includeRects: captureOptions.includeRects,
                    signal: captureOptions.signal,
                    context,
                  }),
                ),
            }
          : {}),
      });
      return snapshot;
    },
    publishSnapshot: (snapshot) => {
      setSessionSnapshot(session, snapshot);
      sessionStore.set(session.name, session);
    },
  });
};

export function createInteractionRuntime(
  params: InteractionRouteInput & {
    pairedGestureViewport?: Rect;
    touchExecutor?: BoundTouchExecutor;
    gestures?: BoundGestureExecutor;
  },
) {
  const session = params.sessionStore.get(params.sessionName);
  if (!session) throw new KernelAppError('SESSION_NOT_FOUND', NO_ACTIVE_SESSION_MESSAGE);
  return createInternalInteractionRuntime({
    requestId: params.req.meta?.requestId,
    flags: params.req.flags,
    session,
    contextFromFlags: params.contextFromFlags,
    captureSnapshot: async (flags, options) =>
      await (params.captureSnapshotForSession ?? captureSnapshotForSession)(
        session,
        flags,
        params.sessionStore,
        params.contextFromFlags,
        options,
      ),
    runtimeSessions: createDaemonRuntimeSessionStore({
      sessionName: params.sessionName,
      getSession: () => session,
      recordOptions: {
        includeSnapshot: true,
        omitRefFrameSnapshot: params.req.internal?.findResolvedTarget !== undefined,
      },
      setRecord: (record) => {
        if (!record.snapshot) return;
        setSessionSnapshot(session, record.snapshot);
        params.sessionStore.set(params.sessionName, session);
      },
    }),
    expireRefFrame: () => expireRefFrame(session),
    confirmOffscreenTargetVisible: isLocalIosRunnerSession(session, {
      skipPendingPostGestureStabilization: false,
    })
      ? async (node, rootViewport) =>
          await confirmIosOffscreenTargetVisible({
            session,
            node,
            rootViewport,
            requestOptions: buildAppleRunnerRequestOptions({
              req: params.req,
              logPath: params.logPath,
              traceLogPath: session.trace?.outPath,
            }),
          })
      : undefined,
    pairedGestureViewport: params.pairedGestureViewport,
    touchExecutor: params.touchExecutor,
    gestures: params.gestures,
  });
}

type FinalizeTouchInteractionInput = Omit<
  Parameters<typeof finalizeInternalInteraction>[0],
  'operations'
> & {
  session: SessionState;
  sessionStore: SessionStore;
};

export function finalizeTouchInteraction(params: FinalizeTouchInteractionInput): DaemonResponse {
  const { session, sessionStore, ...finalization } = params;
  return finalizeInternalInteraction({
    ...finalization,
    operations: {
      recordAction: sessionStore.recordAction.bind(sessionStore, session),
      markDeferredOutcome: (mark) => markDeferredInteractionOutcome({ session, ...mark }),
      isSessionRecording: isSessionRecording.bind(null, session),
      recordGestureVisualization: recordTouchVisualizationEvent.bind(null, session),
    },
  });
}
