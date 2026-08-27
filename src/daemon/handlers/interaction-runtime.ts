import { publicPlatformString } from '@agent-device/kernel/device';
import type {
  AgentDeviceBackend,
  BackendActionResult,
  BackendSnapshotResult,
} from '../../backend.ts';
import { createAgentDevice } from '../../runtime.ts';
import { AppError } from '@agent-device/kernel/errors';
import type { SessionState } from '../types.ts';
import { setSessionSnapshot } from '../session-snapshot.ts';
import { expireRefFrame } from '../ref-frame.ts';
import type { InteractionHandlerParams } from './interaction-common.ts';
import type { CaptureSnapshotForSession } from './interaction-snapshot.ts';
import { createDaemonRuntimePolicy } from '../runtime-policy.ts';
import { createDaemonRuntimeSessionStore } from '../runtime-session.ts';
import { NO_ACTIVE_SESSION_MESSAGE } from './response.ts';
import type { Rect, SnapshotNode } from '@agent-device/kernel/snapshot';
import { getRequestSignal } from '@agent-device/host-kit/request';
import { buildAppleRunnerRequestOptions } from '../apple-runner-options.ts';
import { isLocalIosRunnerSession } from '../direct-ios-selector.ts';
import { confirmIosOffscreenTargetVisible } from '../offscreen-target-probe.ts';
import type { BoundTouchExecutor } from '../touch-runtime.ts';
import type { BoundGestureExecutor } from '../gesture-runtime.ts';
import type { DaemonCommandContext } from '../context.ts';

type InteractionRuntimeParams = InteractionHandlerParams & {
  captureSnapshotForSession: CaptureSnapshotForSession;
  pairedGestureViewport?: Rect;
  touchExecutor?: BoundTouchExecutor;
  /**
   * The request's single gesture binding (ADR 0019), supplied only by the `gesture`/`swipe`
   * handler. Every other interaction command leaves it out, and the backend then exposes no
   * gesture members at all — the touch leaves that share this backend execute no gestures.
   */
  gestures?: BoundGestureExecutor;
};

export function createInteractionRuntime(params: InteractionRuntimeParams) {
  const session = params.sessionStore.get(params.sessionName);
  if (!session) throw new AppError('SESSION_NOT_FOUND', NO_ACTIVE_SESSION_MESSAGE);
  return createAgentDevice({
    backend: createInteractionBackend({ ...params, session }),
    ...createDaemonRuntimePolicy('interaction commands', { plural: true }),
    sessions: createDaemonRuntimeSessionStore({
      sessionName: params.sessionName,
      getSession: () => session,
      recordOptions: {
        includeSnapshot: true,
        // ADR 0014: a mutating find's target came from the fresh operational
        // observation, not the authorized frame tree. Resolution adopts the
        // carried target; other runtime consumers still see that observation.
        omitRefFrameSnapshot: params.req.internal?.findResolvedTarget !== undefined,
      },
      setRecord: (record) => {
        if (!record.snapshot) return;
        setSessionSnapshot(session, record.snapshot);
        params.sessionStore.set(params.sessionName, session);
      },
    }),
    signal: getRequestSignal(params.req.meta?.requestId),
  });
}

function createInteractionBackend(
  params: InteractionRuntimeParams & { session: SessionState },
): AgentDeviceBackend {
  const { req, session } = params;
  const gestureContext = () =>
    params.contextFromFlags(req.flags, session.appBundleId, session.trace?.outPath);
  return {
    platform: publicPlatformString(session.device),
    captureSnapshot: async (context, options): Promise<BackendSnapshotResult> => ({
      snapshot: await params.captureSnapshotForSession(
        session,
        req.flags,
        params.sessionStore,
        params.contextFromFlags,
        {
          interactiveOnly: options?.interactiveOnly === true,
          preferredBackend: options?.preferredBackend,
          includeRects: options?.includeRects === true,
          signal: context.signal,
          boundCapture: params.touchExecutor?.captureSnapshot ?? params.gestures?.captureSnapshot,
        },
      ),
    }),
    ...gestureBackendMembers(params, session, gestureContext),
    // #1542: iOS-only escape hatch for the off-screen refusal double-check.
    // Local (non-provider) iOS sessions get a direct, AX-tree-independent
    // probe (deliberately NOT skipped while postGestureStabilization is
    // pending — see isLocalIosRunnerSession); every other platform/session
    // omits this field, so the guard's decision stays exactly what it is
    // today (fail closed).
    confirmOffscreenTargetVisible: isLocalIosRunnerSession(session, {
      skipPendingPostGestureStabilization: false,
    })
      ? async (_context, node: Pick<SnapshotNode, 'identifier' | 'label'>, rootViewport) =>
          await confirmIosOffscreenTargetVisible({
            session,
            node,
            rootViewport,
            requestOptions: buildAppleRunnerRequestOptions({
              req,
              logPath: params.logPath,
              traceLogPath: session.trace?.outPath,
            }),
          })
      : undefined,
    ...touchBackendMembers(params.touchExecutor, session, req.flags),
  };
}

/**
 * The gesture members, present only for the `gesture`/`swipe` handler that bound them (R52/R54).
 * Every other interaction command shares this backend and executes no gestures, so it gets
 * neither member — the backend holds no gesture reach it cannot prove.
 *
 * A replay-supplied viewport still wins over the owner's own read, exactly as before; an owner
 * with no frame read answers `undefined` and the caller derives the frame from a capture, which
 * is how a Linux gesture resolves its coordinate frame today.
 */
function gestureBackendMembers(
  params: InteractionRuntimeParams,
  session: SessionState,
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
      // ADR 0014 side-effect seam: the plan is built; expire the ref frame synchronously before
      // executing so a later step cannot reuse it.
      expireRefFrame(session);
      return toBackendActionResult(await gestures.performPlan(plan, gestureContext()));
    },
  };
}

function touchBackendMembers(
  executor: BoundTouchExecutor | undefined,
  session: SessionState,
  flags: InteractionRuntimeParams['req']['flags'],
): Partial<AgentDeviceBackend> {
  if (!executor) return {};
  const expire = () => expireRefFrame(session);
  const { tapPoint, tapRef, fillPoint, fillRef, longPressPoint, hoverPoint, hoverRef } = executor;
  return {
    tap: tapPoint
      ? async (_context, point) => {
          expire();
          return toBackendActionResult(await tapPoint(point, flags));
        }
      : undefined,
    tapTarget: tapRef
      ? async (_context, target) => {
          expire();
          return toBackendActionResult(await tapRef(target.ref));
        }
      : undefined,
    fill: fillPoint
      ? async (_context, point, text, options) => {
          expire();
          return toBackendActionResult(await fillPoint(point, text, options));
        }
      : undefined,
    fillTarget: fillRef
      ? async (_context, target, text, options) => {
          expire();
          return toBackendActionResult(await fillRef(target.ref, text, options));
        }
      : undefined,
    longPress: longPressPoint
      ? async (_context, point, options) => {
          expire();
          return toBackendActionResult(await longPressPoint(point, options?.durationMs));
        }
      : undefined,
    hover: hoverPoint
      ? async (_context, point) => {
          expire();
          return toBackendActionResult(await hoverPoint(point));
        }
      : undefined,
    hoverTarget: hoverRef
      ? async (_context, target) => {
          expire();
          return toBackendActionResult(await hoverRef(target.ref));
        }
      : undefined,
  };
}

function toBackendActionResult(data: unknown): BackendActionResult {
  return data && typeof data === 'object' ? (data as Record<string, unknown>) : undefined;
}
