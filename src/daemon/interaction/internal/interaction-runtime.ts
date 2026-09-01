import { publicPlatformString } from '@agent-device/kernel/device';
import { AppError as KernelAppError } from '@agent-device/kernel/errors';
import type {
  AgentDeviceBackend,
  BackendActionResult,
  BackendSnapshotResult,
} from '../../../backend.ts';
import { createAgentDevice } from '../../../runtime.ts';
import { getRequestSignal } from '@agent-device/host-kit/request';
import type { Rect } from '@agent-device/kernel/snapshot';
import type { DaemonCommandContext } from '../../context.ts';
import { createDaemonRuntimePolicy } from '../../runtime-policy.ts';
import { NO_ACTIVE_SESSION_MESSAGE } from '../../response.ts';
import { buildAppleRunnerRequestOptions } from '../../apple-runner-options.ts';
import { isLocalIosRunnerSession } from '../../direct-ios-selector.ts';
import { confirmIosOffscreenTargetVisible } from '../../offscreen-target-probe.ts';
import { createDaemonRuntimeSessionStore } from '../../runtime-session.ts';
import { expireRefFrame } from '../../ref-frame.ts';
import { setSessionSnapshot } from '../../session-snapshot.ts';
import type {
  CaptureSnapshotForSession,
  InteractionRouteInput,
  InteractionRuntimeInput,
} from './types.ts';
import { finalizeTouchInteraction as finalizeInteraction } from './interaction-common.ts';
import { markDeferredInteractionOutcome } from '../../deferred-interaction-outcome.ts';
import { isSessionRecording } from '../../session-script-publication-capability.ts';
import { recordTouchVisualizationEvent } from '../../recording-gestures.ts';
import type { SessionStore } from '../../session-store.ts';
import type { DaemonResponse, SessionState } from '../../types.ts';
import type { BoundTouchExecutor } from '../../touch-runtime.ts';
import type { BoundGestureExecutor } from '../../gesture-runtime.ts';

export function createInteractionRuntimeForRoute(
  params: InteractionRouteInput & {
    captureSnapshotForSession: CaptureSnapshotForSession;
    pairedGestureViewport?: Rect;
    touchExecutor?: BoundTouchExecutor;
    gestures?: BoundGestureExecutor;
  },
) {
  const session = params.sessionStore.get(params.sessionName);
  if (!session) throw new KernelAppError('SESSION_NOT_FOUND', NO_ACTIVE_SESSION_MESSAGE);
  return createInteractionAgentDevice({
    requestId: params.req.meta?.requestId,
    flags: params.req.flags,
    session,
    contextFromFlags: params.contextFromFlags,
    captureSnapshot: async (flags, options) =>
      await params.captureSnapshotForSession(
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
  Parameters<typeof finalizeInteraction>[0],
  'operations'
> & {
  session: SessionState;
  sessionStore: SessionStore;
};

export function finalizeTouchInteraction(params: FinalizeTouchInteractionInput): DaemonResponse {
  const { session, sessionStore, ...finalization } = params;
  return finalizeInteraction({
    ...finalization,
    operations: {
      recordAction: sessionStore.recordAction.bind(sessionStore, session),
      markDeferredOutcome: (mark) => markDeferredInteractionOutcome({ session, ...mark }),
      isSessionRecording: isSessionRecording.bind(null, session),
      recordGestureVisualization: recordTouchVisualizationEvent.bind(null, session),
    },
  });
}

function createInteractionAgentDevice(params: InteractionRuntimeInput) {
  return createAgentDevice({
    backend: createInteractionBackend(params),
    ...createDaemonRuntimePolicy('interaction commands', { plural: true }),
    sessions: params.runtimeSessions,
    signal: getRequestSignal(params.requestId),
  });
}

function createInteractionBackend(params: InteractionRuntimeInput): AgentDeviceBackend {
  const { flags, session } = params;
  const gestureContext = () =>
    params.contextFromFlags(flags, session.appBundleId, session.trace?.outPath);
  return {
    platform: publicPlatformString(session.device),
    captureSnapshot: async (context, options): Promise<BackendSnapshotResult> => ({
      snapshot: await params.captureSnapshot(flags, {
        interactiveOnly: options?.interactiveOnly === true,
        preferredBackend: options?.preferredBackend,
        includeRects: options?.includeRects === true,
        signal: context.signal,
        boundCapture: params.touchExecutor?.captureSnapshot ?? params.gestures?.captureSnapshot,
      }),
    }),
    ...gestureBackendMembers(params, gestureContext),
    ...(params.confirmOffscreenTargetVisible
      ? {
          confirmOffscreenTargetVisible: async (_context, node, rootViewport) =>
            await params.confirmOffscreenTargetVisible!(node, rootViewport),
        }
      : {}),
    ...touchBackendMembers(params.touchExecutor, params.expireRefFrame, flags),
  };
}

function gestureBackendMembers(
  params: InteractionRuntimeInput,
  gestureContext: () => DaemonCommandContext,
): Pick<AgentDeviceBackend, 'performGesture' | 'resolveGestureViewport'> {
  const gestures = params.gestures;
  const pairedGestureViewport = params.pairedGestureViewport;
  if (!gestures) {
    return pairedGestureViewport
      ? { resolveGestureViewport: async (): Promise<Rect> => pairedGestureViewport }
      : {};
  }
  return {
    resolveGestureViewport: async (): Promise<Rect | undefined> =>
      pairedGestureViewport ?? (await gestures.gestureViewport?.(gestureContext())),
    performGesture: async (_context, plan): Promise<BackendActionResult> => {
      params.expireRefFrame();
      return toBackendActionResult(await gestures.performPlan(plan, gestureContext()));
    },
  };
}

function touchBackendMembers(
  executor: InteractionRuntimeInput['touchExecutor'],
  expireRefFrame: () => void,
  flags: InteractionRuntimeInput['flags'],
): Partial<AgentDeviceBackend> {
  if (!executor) return {};
  const { tapPoint, tapRef, fillPoint, fillRef, longPressPoint, hoverPoint, hoverRef } = executor;
  const run = async (action: () => unknown): Promise<BackendActionResult> => {
    expireRefFrame();
    return toBackendActionResult(await action());
  };
  return {
    tap: tapPoint ? (_context, point) => run(() => tapPoint(point, flags)) : undefined,
    tapTarget: tapRef ? (_context, target) => run(() => tapRef(target.ref)) : undefined,
    fill: fillPoint
      ? (_context, point, text, options) => run(() => fillPoint(point, text, options))
      : undefined,
    fillTarget: fillRef
      ? (_context, target, text, options) => run(() => fillRef(target.ref, text, options))
      : undefined,
    longPress: longPressPoint
      ? (_context, point, options) => run(() => longPressPoint(point, options?.durationMs))
      : undefined,
    hover: hoverPoint ? (_context, point) => run(() => hoverPoint(point)) : undefined,
    hoverTarget: hoverRef ? (_context, target) => run(() => hoverRef(target.ref)) : undefined,
  };
}

function toBackendActionResult(data: unknown): BackendActionResult {
  return data && typeof data === 'object' ? (data as Record<string, unknown>) : undefined;
}
