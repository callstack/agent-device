import type { NormalizedError } from '@agent-device/kernel/errors';

/**
 * Whether a failed Android snapshot is the accessibility-timeout shape that the screenshot
 * evidence path exists for (#1983).
 *
 * The recognition is deliberately two-sided. The helper reports a typed `TimeoutException` when
 * it gets far enough to answer at all; when it does not, the daemon's own hint text is the only
 * surviving evidence that the capture was blocked rather than merely failed. Neither side alone
 * covers both, so this predicate keeps both and stays a policy, not an error-code lookup.
 */
export function isAndroidSnapshotTimeoutError(error: NormalizedError): boolean {
  if (error.code !== 'COMMAND_FAILED') return false;
  return (
    hasKnownAndroidSnapshotTimeoutMessage(error) || hasHelperTimeoutDetails(error.details?.helper)
  );
}

function hasKnownAndroidSnapshotTimeoutMessage(error: NormalizedError): boolean {
  const text = `${error.message}\n${error.hint ?? ''}`;
  return /Android accessibility snapshots can be blocked/i.test(text);
}

function hasHelperTimeoutDetails(helper: unknown): boolean {
  if (!helper || typeof helper !== 'object') return false;
  const helperRecord = helper as Record<string, unknown>;
  const errorType = String(helperRecord.errorType ?? '');
  const message = String(helperRecord.message ?? '');
  return /TimeoutException/i.test(errorType) || /timed out/i.test(message);
}
