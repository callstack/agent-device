import { bindInteractionSession } from './internal/interaction-session.ts';
import type { Rect } from '@agent-device/kernel/snapshot';
import { buildRuntimeCaptureInput } from '../snapshot-runtime-capture-input.ts';
import { setSessionSnapshot } from '../session-snapshot.ts';
import { captureSnapshot } from '../snapshot-capture.ts';
import { captureInteractionSnapshot } from './internal/interaction-snapshot.ts';
import { createInteractionRuntimeForRoute } from './internal/interaction-runtime.ts';
import { readSettleRequest, settleFlagGuardResponse } from './internal/interaction-flags.ts';
import type {
  CaptureSnapshotForSession,
  FindRouteInput,
  InteractionRouteInput,
} from './internal/types.ts';

export type { FindRouteInput, InteractionRouteInput } from './internal/types.ts';

export { refMutationAdmissionResponse } from './internal/interaction-ref-policy.ts';
export { finalizeTouchInteraction } from './internal/interaction-runtime.ts';
export { bindInteractionSession };

export { readSettleRequest, settleFlagGuardResponse };

export const captureSnapshotForSession: CaptureSnapshotForSession = async (
  ref,
  flags,
  sessionStore,
  contextFromFlags,
  options,
) => {
  const session = sessionStore.requireCurrent(ref);
  return await captureInteractionSnapshot({
    session,
    flags,
    contextFromFlags,
    options,
    capture: async ({ flags: effectiveFlags, options: captureOptions, context }) => {
      const { snapshot } = await captureSnapshot({
        device: session.device,
        session,
        flags: effectiveFlags,
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
      setSessionSnapshot(sessionStore.requireCurrent(ref), snapshot);
    },
  });
};

export function createInteractionRuntime(
  params: InteractionRouteInput & {
    pairedGestureViewport?: Rect;
    touchExecutor?: import('../touch-runtime.ts').BoundTouchExecutor;
    gestures?: import('../gesture-runtime.ts').BoundGestureExecutor;
  },
) {
  return createInteractionRuntimeForRoute({
    ...bindInteractionSession(params),
    captureSnapshotForSession: params.captureSnapshotForSession ?? captureSnapshotForSession,
  });
}

export async function handleFindCommands(params: FindRouteInput) {
  return (await import('./internal/find.ts')).handleFindCommands(params);
}

export async function handleInteractionCommands(params: InteractionRouteInput) {
  const bound = bindInteractionSession(params);
  const module = await import('./internal/interaction.ts');
  return await module.handleInteractionCommands({
    ...bound,
    captureSnapshotForSession: params.captureSnapshotForSession ?? captureSnapshotForSession,
  });
}
