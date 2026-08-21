import type { CommandFlags } from '@agent-device/contracts/command';
import type { SessionStore } from '../session-store.ts';
import type { SessionState } from '../types.ts';
import type { SnapshotPreferredBackend, SnapshotState } from '@agent-device/kernel/snapshot';
import type { ContextFromFlags } from './interaction-common.ts';
import { captureSnapshot } from './snapshot-capture.ts';
import { setSessionSnapshot } from '../session-snapshot.ts';
import { isSparseSnapshotQualityVerdict } from '../../snapshot-quality/verdict.ts';
import { snapshotOptionsToFlags } from '../../backend-snapshot-options.ts';

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
  const { snapshot } = await captureSnapshot({
    device: session.device,
    session,
    flags: effectiveFlags,
    outPath: effectiveFlags.out,
    logPath: dispatchContext.logPath ?? '',
    includeRects: options.includeRects,
    androidFreshnessMode: options.androidFreshnessMode,
    signal: options.signal,
  });
  if (!isSparseSnapshotQualityVerdict(snapshot.snapshotQuality)) {
    setSessionSnapshot(session, snapshot);
    sessionStore.set(session.name, session);
  }
  return snapshot;
}
