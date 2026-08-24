import { emitDiagnostic } from '../../utils/diagnostics.ts';
import { getActiveAndroidSnapshotFreshness } from '../session-snapshot-freshness.ts';
import type { SessionState } from '../types.ts';
import type { InteractionHandlerParams } from './interaction-common.ts';
import type { CaptureSnapshotForSession } from './interaction-snapshot.ts';

/**
 * The Android ref-refresh capture a `@ref` mutation takes before dispatch, and
 * the comparison-safe baseline it hands finalization so the freshness route
 * stays comparable across the action.
 */

export async function refreshAndroidRefSnapshotIfFreshnessActive(
  params: InteractionHandlerParams & {
    captureSnapshotForSession: CaptureSnapshotForSession;
  },
  session: SessionState,
): Promise<SessionState['snapshot']> {
  if (!getActiveAndroidSnapshotFreshness(session)) return undefined;
  const freshnessBaseline =
    session.snapshot?.comparisonSafe === true ? session.snapshot : undefined;
  try {
    await params.captureSnapshotForSession(
      session,
      params.req.flags,
      params.sessionStore,
      params.contextFromFlags,
      { interactiveOnly: true, androidFreshnessMode: 'ref-refresh' },
    );
  } catch (error) {
    emitDiagnostic({
      level: 'warn',
      phase: 'android_ref_snapshot_refresh_failed',
      data: {
        command: params.req.command,
        error: error instanceof Error ? error.message : String(error),
      },
    });
  }
  return freshnessBaseline;
}
