import { publicPlatformString } from '@agent-device/kernel/device';
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
import type { InteractionRuntimeInput } from './types.ts';

export function createInteractionRuntime(params: InteractionRuntimeInput) {
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
