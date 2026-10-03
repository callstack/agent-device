import type { NormalizedError } from '@agent-device/kernel/errors';
import { readAndroidCaptureFailureReason } from '@agent-device/contracts/android-snapshot-quality';

/**
 * Whether a failed Android snapshot is the accessibility-timeout shape that the screenshot
 * evidence path exists for (#1983).
 *
 * This reads the typed reason the Android platform boundary published when it classified the
 * failure; it does not re-derive that classification. The producer is the only place that knows
 * whether the helper answered with a structured timeout or was killed before it could answer, and
 * a second reader sniffing hint prose would drift from it the first time the prose is reworded.
 */
export function isAndroidSnapshotTimeoutError(error: NormalizedError): boolean {
  return readAndroidCaptureFailureReason(error) === 'accessibility-timeout';
}
