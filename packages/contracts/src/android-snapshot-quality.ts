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

/**
 * Why an Android capture failed at the mechanism level, as a typed reason rather than a message
 * shape. `accessibility-timeout` means the hierarchy never arrived — the helper reported a
 * structured timeout, or its instrumentation was killed before it could answer.
 *
 * The producer decides this once, at the platform boundary, and publishes the decision. Readers
 * consume the reason instead of re-deriving it from hint text: the hint is human-facing prose
 * that may be reworded, and two readers sniffing it will drift apart (#1983).
 */
export const ANDROID_CAPTURE_FAILURE_REASONS = ['accessibility-timeout'] as const;

export type AndroidCaptureFailureReason = (typeof ANDROID_CAPTURE_FAILURE_REASONS)[number];

const ANDROID_CAPTURE_FAILURE_REASON_SET: ReadonlySet<string> = new Set(
  ANDROID_CAPTURE_FAILURE_REASONS,
);

export function isAndroidCaptureFailureReason(
  value: unknown,
): value is AndroidCaptureFailureReason {
  return typeof value === 'string' && ANDROID_CAPTURE_FAILURE_REASON_SET.has(value);
}

/** The typed reason a thrown Android capture failure carries, when its producer named one. */
export function readAndroidCaptureFailureReason(
  error: unknown,
): AndroidCaptureFailureReason | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const details = (error as { details?: Record<string, unknown> }).details;
  const reason = details?.androidCaptureFailureReason;
  return isAndroidCaptureFailureReason(reason) ? reason : undefined;
}
