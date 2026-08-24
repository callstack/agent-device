import { dispatchGesturePlan, dispatchGestureViewport } from '../../core/dispatch.ts';
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
import { getRequestSignal } from '../../request/cancel.ts';
import { buildAppleRunnerRequestOptions } from '../apple-runner-options.ts';
import { isLocalIosRunnerSession } from '../direct-ios-selector.ts';
import { confirmIosOffscreenTargetVisible } from '../offscreen-target-probe.ts';
import type { BoundTouchExecutor } from '../touch-runtime.ts';

type InteractionRuntimeParams = InteractionHandlerParams & {
  captureSnapshotForSession: CaptureSnapshotForSession;
  pairedGestureViewport?: Rect;
  touchExecutor?: BoundTouchExecutor;
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
          boundCapture: params.touchExecutor?.captureSnapshot,
        },
      ),
    }),
    resolveGestureViewport: async () =>
      params.pairedGestureViewport ??
      (await dispatchGestureViewport(
        session.device,
        params.contextFromFlags(req.flags, session.appBundleId, session.trace?.outPath),
      )),
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
    performGesture: async (_context, plan): Promise<BackendActionResult> => {
      expireRefFrame(session);
      return toBackendActionResult(
        await dispatchGesturePlan(
          session.device,
          plan,
          params.contextFromFlags(req.flags, session.appBundleId, session.trace?.outPath),
        ),
      );
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
