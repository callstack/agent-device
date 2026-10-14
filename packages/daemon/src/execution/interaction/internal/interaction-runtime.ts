import { bindInteractionSession } from './interaction-session.ts';
import { publicPlatformString } from '@agent-device/kernel/device';
import { AppError as KernelAppError } from '@agent-device/kernel/errors';
import type {
  AgentDeviceBackend,
  BackendActionResult,
  BackendSnapshotResult,
} from '@agent-device/contracts/backend';
import { getRequestSignal } from '@agent-device/host-kit/request';
import type { Rect, SnapshotState } from '@agent-device/kernel/snapshot';
import type { DaemonCommandContext } from '../../../core/context.ts';
import { createDaemonRuntimePolicy } from '../../runtime-policy.ts';
import { recordCaptureProof } from '../../../core/capture-disclosure.ts';
import { confirmIosOffscreenTargetVisible } from '../../offscreen-target-probe.ts';
import { runtimeExecutionFromContext } from '../../../core/snapshot-runtime-capture-input.ts';
import { createDaemonRuntimeSessionStore } from '../../../core/runtime-session.ts';
import { expireRefFrame } from '../../../core/ref-frame.ts';
import { setSessionSnapshot } from '../../session-snapshot.ts';
import type {
  CaptureSnapshotForSession,
  InteractionRouteInput,
  InteractionRuntimeInput,
  SettleObservationCaptureInput,
} from '../../../core/interaction/internal/types.ts';
import { finalizeTouchInteraction as finalizeInteraction } from './interaction-common.ts';
import { markDeferredInteractionOutcome } from '../../../core/deferred-interaction-outcome.ts';
import { isSessionRecording } from '../../../core/session-script-publication-capability.ts';
import { recordTouchVisualizationEvent } from '../../../core/recording-gestures.ts';
import type { SessionStore } from '../../../core/session-store.ts';
import type { DaemonResponse } from '../../../core/daemon-request.ts';
import type { SessionRef } from '../../../core/session-state.ts';
import type { BoundTouchExecutor } from '../../../core/touch-runtime.ts';
import type { BoundGestureExecutor } from '../../../core/gesture-runtime.ts';
import type { BoundSnapshotCapture } from '../../../core/snapshot-runtime-binding.ts';
import { NO_ACTIVE_SESSION_MESSAGE } from '@agent-device/kernel/contracts';

export async function createInteractionRuntimeForRoute(
  params: SettleObservationCaptureInput &
    InteractionRouteInput & {
      captureSnapshotForSession: CaptureSnapshotForSession;
      pairedGestureViewport?: Rect;
      touchExecutor?: BoundTouchExecutor;
      gestures?: BoundGestureExecutor;
      /**
       * Filled with the LAST capture this request consumed. ADR 0014 ambiguity
       * issuance is only valid against a tree the session stored under the
       * generation it freezes, and a sparse-quality capture deliberately stores
       * nothing — the refusal seam needs the same consumed-capture slot the
       * selector routes carry (`consumedSnapshot`), owned per dispatch.
       */
      consumedCapture?: { state?: SnapshotState };
    },
) {
  const ref = bindInteractionSession(params).sessionRef;
  if (!ref) throw new KernelAppError('SESSION_NOT_FOUND', NO_ACTIVE_SESSION_MESSAGE);
  const session = params.sessionStore.requireCurrent(ref);
  return await createInteractionAgentDevice({
    createCommandSurface: params.createCommandSurface,
    requestId: params.req.meta?.requestId,
    flags: params.req.flags,
    session,
    contextFromFlags: params.contextFromFlags,
    captureSnapshot: async (flags, options) => {
      const snapshot = await params.captureSnapshotForSession(
        ref,
        flags,
        params.sessionStore,
        params.contextFromFlags,
        options,
      );
      if (params.consumedCapture) params.consumedCapture.state = snapshot;
      return recordCaptureProof(params.captureProof, snapshot);
    },
    runtimeSessions: createDaemonRuntimeSessionStore({
      sessionName: params.sessionName,
      sessionStore: params.sessionStore,
      ref,
      recordOptions: {
        includeSnapshot: true,
        omitRefFrameSnapshot: params.req.internal?.findResolvedTarget !== undefined,
      },
      setRecord: (record, current) => {
        if (!record.snapshot) return;
        setSessionSnapshot(current!, record.snapshot);
      },
    }),
    expireRefFrame: () => expireRefFrame(params.sessionStore.requireCurrent(ref)),
    // The #1542 rescue hook installs only when this request's own binding admitted the live
    // selector read — the same conditional fact the guard's refusal is built on, so the hook and
    // the verdict it may overturn come from one admission (ADR 0019 §2). A session whose owner did
    // not advertise the read keeps the bulk-tree verdict unchanged.
    confirmOffscreenTargetVisible: readOffscreenTargetRescue(params, session),
    pairedGestureViewport: params.pairedGestureViewport,
    touchExecutor: params.touchExecutor,
    gestures: params.gestures,
    boundCapture: resolveBoundCapture(params),
  });
}

/**
 * The #1542 rescue read over the live selector query, or `undefined` when this request must not
 * hold one. It installs only on a route whose own request-bound binding admitted the CONDITIONAL
 * `querySelector` operation (the touch or gesture use it already holds; ADR 0019 §2), which is the
 * whole gate: only the local Apple owner declares the read, and only on iOS-family leaves, so
 * provider-owned devices (whose facts start every operation unavailable and never declare it),
 * the macOS desktop, and every other platform never hold the hook — their guard refuses on the
 * bulk-tree verdict unchanged.
 */
function readOffscreenTargetRescue(
  params: InteractionRouteInput & {
    touchExecutor?: BoundTouchExecutor;
    gestures?: BoundGestureExecutor;
  },
  session: Parameters<typeof confirmIosOffscreenTargetVisible>[0]['session'],
): InteractionRuntimeInput['confirmOffscreenTargetVisible'] {
  const querySelector = params.touchExecutor?.querySelector ?? params.gestures?.querySelector;
  if (!querySelector) return undefined;
  return async (node, rootViewport) =>
    await confirmIosOffscreenTargetVisible({
      session,
      node,
      rootViewport,
      querySelector,
      execution: runtimeExecutionFromContext(
        params.contextFromFlags(params.req.flags, session.appBundleId, session.trace?.outPath),
      ),
    });
}

type FinalizeTouchInteractionInput = Omit<
  Parameters<typeof finalizeInteraction>[0],
  'operations'
> & {
  ref: SessionRef;
  sessionStore: SessionStore;
};

export function finalizeTouchInteraction(params: FinalizeTouchInteractionInput): DaemonResponse {
  const { ref, sessionStore, ...finalization } = params;
  const session = sessionStore.requireCurrent(ref);
  return finalizeInteraction({
    ...finalization,
    operations: {
      recordAction: sessionStore.recordAction.bind(sessionStore, ref),
      markDeferredOutcome: (mark) => markDeferredInteractionOutcome({ session, ...mark }),
      isSessionRecording: isSessionRecording.bind(null, session),
      recordGestureVisualization: recordTouchVisualizationEvent.bind(null, session),
    },
  });
}

/**
 * The capture implementation every observation on this request reads the screen through: the action
 * binding's own capture when its runtime use carries one, otherwise the capture the request admitted
 * for its observations (`settle-observation-capture.ts`). Resolved once, at construction, so a route
 * cannot answer one capture from the request-bound runtime and the next from the legacy path. Which
 * backend a bound capture presents stays per-capture: the settle loop pins it once it sees a
 * `private-ax` verdict.
 */
function resolveBoundCapture(
  params: SettleObservationCaptureInput & {
    touchExecutor?: BoundTouchExecutor;
    gestures?: BoundGestureExecutor;
  },
): BoundSnapshotCapture | undefined {
  return (
    params.touchExecutor?.captureSnapshot ??
    params.gestures?.captureSnapshot ??
    params.settleObservationCapture
  );
}

function createInteractionAgentDevice(params: InteractionRuntimeInput) {
  return params.createCommandSurface({
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
        boundCapture: params.boundCapture,
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
