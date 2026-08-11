/**
 * Android helper content verdicts. The helper captured a tree successfully, but the
 * current screen did not contain enough readable application content to use as a
 * snapshot. Keep the enumeration here so the producer, waits, and replay recovery
 * cannot grow different retry taxonomies.
 */
export const ANDROID_CONTENT_RECOVERY_REASONS = [
  'empty-helper-output',
  'system-window-only',
  'content-poor-app-window',
] as const;

export type AndroidContentRecoveryReason = (typeof ANDROID_CONTENT_RECOVERY_REASONS)[number];

const ANDROID_CONTENT_RECOVERY_REASON_SET: ReadonlySet<string> = new Set(
  ANDROID_CONTENT_RECOVERY_REASONS,
);

export function isAndroidContentRecoveryReason(
  value: unknown,
): value is AndroidContentRecoveryReason {
  return typeof value === 'string' && ANDROID_CONTENT_RECOVERY_REASON_SET.has(value);
}

/**
 * True when a thrown Android capture failure is a content verdict rather than a
 * mechanism failure. Wait and replay polling may ride out these states; helper
 * timeouts, adb failures, and missing artifacts remain fail-fast.
 */
export function isUnreadableCaptureContentError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const details = (error as { details?: Record<string, unknown> }).details;
  const reason = details?.androidSnapshotHelperFailureReason;
  return isAndroidContentRecoveryReason(reason);
}
