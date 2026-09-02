import type { Rect } from '@agent-device/kernel/snapshot';
import { buildRuntimeCaptureInput } from '../snapshot-runtime-capture-input.ts';
import { setSessionSnapshot } from '../session-snapshot.ts';
import { captureSnapshot as captureSnapshotThroughHandler } from '../handlers/snapshot-capture.ts';
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

export { readSettleRequest, settleFlagGuardResponse };

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
    touchExecutor?: import('../touch-runtime.ts').BoundTouchExecutor;
    gestures?: import('../gesture-runtime.ts').BoundGestureExecutor;
  },
) {
  return createInteractionRuntimeForRoute({
    ...params,
    captureSnapshotForSession: params.captureSnapshotForSession ?? captureSnapshotForSession,
  });
}

export async function handleFindCommands(params: FindRouteInput) {
  return (await import('./internal/find.ts')).handleFindCommands(params);
}

export async function handleInteractionCommands(params: InteractionRouteInput) {
  const module = await import('./internal/interaction.ts');
  return await module.handleInteractionCommands({
    ...params,
    captureSnapshotForSession: params.captureSnapshotForSession ?? captureSnapshotForSession,
  });
}
