import type { CommandFlags } from '@agent-device/contracts/command';
import type { SessionStore } from '../session-store.ts';
import type { SessionState } from '../types.ts';
import type { SnapshotPreferredBackend, SnapshotState } from '@agent-device/kernel/snapshot';
import type { ContextFromFlags } from './interaction-common.ts';
import { captureSnapshot } from './snapshot-capture.ts';
import { setSessionSnapshot } from '../session-snapshot.ts';
import { isSparseSnapshotQualityVerdict } from '@agent-device/capture-kit/snapshot-quality-verdict';
import { snapshotOptionsToFlags } from '../../backend-snapshot-options.ts';
import type {
  CaptureSnapshotInput,
  SnapshotResult,
} from '@agent-device/contracts/snapshot-runtime';
import { buildRuntimeCaptureInput } from '../snapshot-runtime-capture-input.ts';

export type BoundInteractionCapture = (input: CaptureSnapshotInput) => Promise<SnapshotResult>;

export type CaptureSnapshotForSession = (
  session: SessionState,
  flags: CommandFlags | undefined,
  sessionStore: SessionStore,
  contextFromFlags: ContextFromFlags,
  options: {
    interactiveOnly: boolean;
    preferredBackend?: SnapshotPreferredBackend;
    androidFreshnessMode?: 'ref-refresh';
    includeRects?: boolean;
    signal?: AbortSignal;
    boundCapture?: BoundInteractionCapture;
  },
) => Promise<SnapshotState>;

export async function captureSnapshotForSession(
  session: SessionState,
  flags: CommandFlags | undefined,
  sessionStore: SessionStore,
  contextFromFlags: ContextFromFlags,
  options: {
    interactiveOnly: boolean;
    preferredBackend?: SnapshotPreferredBackend;
    androidFreshnessMode?: 'ref-refresh';
    includeRects?: boolean;
    signal?: AbortSignal;
    boundCapture?: BoundInteractionCapture;
  },
): Promise<SnapshotState> {
  const effectiveFlags = {
    ...(flags ?? {}),
    ...snapshotOptionsToFlags(options),
  };
  const dispatchContext = contextFromFlags(
    effectiveFlags,
    session.appBundleId,
    session.trace?.outPath,
  );
  const boundCapture = options.boundCapture;
  const { snapshot } = await captureSnapshot({
    device: session.device,
    session,
    flags: effectiveFlags,
    outPath: effectiveFlags.out,
    logPath: dispatchContext.logPath ?? '',
    includeRects: options.includeRects,
    androidFreshnessMode: options.androidFreshnessMode,
    signal: options.signal,
    ...(boundCapture
      ? {
          captureData: async () =>
            await boundCapture(
              buildRuntimeCaptureInput({
                flags: effectiveFlags,
                session,
                snapshotScope: effectiveFlags.snapshotScope,
                includeRects: options.includeRects,
                signal: options.signal,
                context: dispatchContext,
              }),
            ),
        }
      : {}),
  });
  if (!isSparseSnapshotQualityVerdict(snapshot.snapshotQuality)) {
    setSessionSnapshot(session, snapshot);
    sessionStore.set(session.name, session);
  }
  return snapshot;
}
