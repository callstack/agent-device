import {
  dispatchCommand,
  dispatchGesturePlan,
  dispatchGestureViewport,
} from '../../core/dispatch.ts';
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
import { resolveWebProvider, type WebProvider } from '../../platforms/web/provider.ts';
import { stripAtPrefix } from './interaction-touch-targets.ts';
import { NO_ACTIVE_SESSION_MESSAGE } from './response.ts';
import type { Rect, SnapshotNode } from '@agent-device/kernel/snapshot';
import { getRequestSignal } from '../../request/cancel.ts';
import { buildAppleRunnerRequestOptions } from '../apple-runner-options.ts';
import { isLocalIosRunnerSession } from '../direct-ios-selector.ts';
import { confirmIosOffscreenTargetVisible } from '../offscreen-target-probe.ts';

type InteractionRuntimeParams = InteractionHandlerParams & {
  captureSnapshotForSession: CaptureSnapshotForSession;
  pairedGestureViewport?: Rect;
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
  const webProvider = resolveNativeWebInteractionProvider(session);
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
          includeRects: options?.includeRects === true,
          signal: context.signal,
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
    tap: async (_context, point): Promise<BackendActionResult> => {
      // ADR 0014 side-effect seam: the point is resolved; expire the ref frame
      // synchronously before dispatching so a later step cannot reuse it.
      expireRefFrame(session);
      return toBackendActionResult(
        await dispatchCommand(
          session.device,
          'press',
          [String(point.x), String(point.y)],
          req.flags?.out,
          params.contextFromFlags(req.flags, session.appBundleId, session.trace?.outPath),
        ),
      );
    },
    tapTarget: webProvider?.clickRef
      ? async (_context, target): Promise<BackendActionResult> => {
          expireRefFrame(session);
          await webProvider.clickRef?.(target.ref);
          return { ref: stripAtPrefix(target.ref) };
        }
      : undefined,
    fill: async (_context, point, text, options): Promise<BackendActionResult> => {
      expireRefFrame(session);
      return toBackendActionResult(
        await dispatchCommand(
          session.device,
          'fill',
          [String(point.x), String(point.y), text],
          req.flags?.out,
          {
            ...params.contextFromFlags(req.flags, session.appBundleId, session.trace?.outPath),
            allowNonHittableCoordinateFallback: options?.allowNonHittableCoordinateFallback,
          },
        ),
      );
    },
    fillTarget: webProvider?.fillRef
      ? async (_context, target, text, options): Promise<BackendActionResult> => {
          expireRefFrame(session);
          await webProvider.fillRef?.(target.ref, text, options);
          return {
            ref: stripAtPrefix(target.ref),
            text,
            delayMs: options?.delayMs ?? 0,
          };
        }
      : undefined,
    longPress: async (_context, point, options): Promise<BackendActionResult> => {
      expireRefFrame(session);
      return toBackendActionResult(
        await dispatchCommand(
          session.device,
          'longpress',
          [
            String(point.x),
            String(point.y),
            ...(options?.durationMs === undefined ? [] : [String(options.durationMs)]),
          ],
          req.flags?.out,
          params.contextFromFlags(req.flags, session.appBundleId, session.trace?.outPath),
        ),
      );
    },
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
    typeText: async (_context, text): Promise<BackendActionResult> => {
      expireRefFrame(session);
      return toBackendActionResult(
        await dispatchCommand(
          session.device,
          'type',
          [text],
          req.flags?.out,
          params.contextFromFlags(req.flags, session.appBundleId, session.trace?.outPath),
        ),
      );
    },
  };
}

function resolveNativeWebInteractionProvider(session: SessionState): WebProvider | undefined {
  if (session.device.platform !== 'web') return undefined;
  const provider = resolveWebProvider();
  return provider.clickRef || provider.fillRef ? provider : undefined;
}

function toBackendActionResult(data: unknown): BackendActionResult {
  return data && typeof data === 'object' ? (data as Record<string, unknown>) : undefined;
}
