import type { SnapshotState } from '@agent-device/kernel/snapshot';
import {
  ANDROID_COMPARISON_BASELINE_MAX_AGE_MS,
  ANDROID_FRESHNESS_RETRY_BUDGET_MS,
  ANDROID_FRESHNESS_RETRY_DELAYS_MS,
  ANDROID_FRESHNESS_WINDOW_MS,
  androidFreshnessReason,
  buildSnapshotSignatures,
  captureFreshnessRecoveredAttempt,
  type SnapshotFreshnessAttemptShape,
  type SnapshotFreshnessMode,
  type SnapshotFreshnessWindow,
} from '../snapshot/snapshot-freshness/index.ts';
import type { SessionState } from './types.ts';

/**
 * Session binding for the neutral snapshot-freshness facet (#1983).
 *
 * The staleness policy, its thresholds and the recovery loop live in
 * `src/snapshot/snapshot-freshness/`. What stays here is the part that is genuinely daemon
 * assembly: reading and retiring the window that hangs off store-owned `SessionState`, and
 * choosing the comparison baseline from session snapshot lineage. This module is the declared
 * R7 owner of `SessionState.androidSnapshotFreshness`.
 */
export function markAndroidSnapshotFreshness(
  session: SessionState,
  action: string,
  baseline = session.snapshot,
): void {
  if (session.device.platform !== 'android') return;
  const comparisonBaseline = resolveAndroidComparisonBaseline(session, baseline);
  // Route-stuck recovery only makes sense against a baseline captured in a broad, comparable
  // shape. Interactive/scoped/depth-limited snapshots are still useful for users, but they are
  // too pruned to serve as a reliable "same route vs new route" baseline.
  const routeComparable = comparisonBaseline?.comparisonSafe === true;
  session.androidSnapshotFreshness = {
    action,
    markedAt: Date.now(),
    baselineCount: (comparisonBaseline ?? baseline)?.nodes.length ?? 0,
    baselineSignatures: routeComparable
      ? buildSnapshotSignatures(comparisonBaseline?.nodes ?? [])
      : undefined,
    routeComparable,
  };
}

function resolveAndroidComparisonBaseline(
  session: SessionState,
  baseline: SnapshotState | undefined,
): SnapshotState | undefined {
  if (baseline?.comparisonSafe === true) return baseline;
  const previous = session.lastComparisonSafeSnapshot;
  if (!previous || previous.comparisonSafe !== true) return baseline;
  return Date.now() - previous.createdAt <= ANDROID_COMPARISON_BASELINE_MAX_AGE_MS
    ? previous
    : baseline;
}

export function getActiveAndroidSnapshotFreshness(
  session: SessionState | undefined,
): SnapshotFreshnessWindow | undefined {
  if (!session || session.device.platform !== 'android') return undefined;
  const freshness = session.androidSnapshotFreshness;
  if (!freshness) return undefined;
  if (Date.now() - freshness.markedAt > ANDROID_FRESHNESS_WINDOW_MS) {
    delete session.androidSnapshotFreshness;
    return undefined;
  }
  return freshness;
}

export function clearAndroidSnapshotFreshness(session: SessionState | undefined): void {
  if (!session || session.device.platform !== 'android') return;
  delete session.androidSnapshotFreshness;
}

/**
 * Runs the facet's recovery loop with the Android policy and retry schedule bound to it, and
 * retires the session window when a trustworthy capture was seen.
 */
export async function captureAndroidFreshnessRecoveredAttempt<
  T extends SnapshotFreshnessAttemptShape,
>(
  params: {
    session: SessionState | undefined;
    interactiveOnly: boolean;
    androidFreshnessMode?: SnapshotFreshnessMode;
    capture: () => Promise<T>;
  },
  freshness: SnapshotFreshnessWindow,
): Promise<T> {
  return captureFreshnessRecoveredAttempt({
    capture: params.capture,
    classify: (attempt) =>
      androidFreshnessReason(
        { snapshot: attempt.snapshot, rawNodeCount: attempt.annotations.analysis?.rawNodeCount },
        freshness,
        { interactiveOnly: params.interactiveOnly, mode: params.androidFreshnessMode },
      ),
    window: freshness,
    retry: {
      retryBudgetMs: ANDROID_FRESHNESS_RETRY_BUDGET_MS,
      delaysMs: ANDROID_FRESHNESS_RETRY_DELAYS_MS,
    },
    onTrustworthyCapture: () => clearAndroidSnapshotFreshness(params.session),
  });
}
