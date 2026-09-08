export {
  ANDROID_COMPARISON_BASELINE_MAX_AGE_MS,
  ANDROID_FRESHNESS_RETRY_BUDGET_MS,
  ANDROID_FRESHNESS_RETRY_DELAYS_MS,
  ANDROID_FRESHNESS_WINDOW_MS,
  androidFreshnessReason,
  buildSnapshotSignatures,
  isNavigationSensitiveAction,
} from './android.ts';
export {
  captureFreshnessRecoveredAttempt,
  type SnapshotFreshnessAttemptShape,
} from './recovery.ts';
export type { SnapshotFreshnessMode, SnapshotFreshnessWindow } from './types.ts';
