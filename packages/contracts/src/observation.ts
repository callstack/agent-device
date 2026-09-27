import { AppError } from '@agent-device/kernel/errors';
import { isUnreadableCaptureContentError } from './android-snapshot-quality.ts';

/**
 * How an observation loop ended. One vocabulary for every loop that captures until a predicate
 * holds: readiness before an action, quiet after a gesture, movement after a scroll, a wait.
 *
 * - `done` — the predicate accepted a capture.
 * - `expired` — the budget ran out while the predicate still said continue.
 * - `stalled` — a capture was still in flight at the deadline; it was cancelled and joined, so no
 *   late result can mutate state after the loop returned.
 * - `failed` — a capture error the loop does not ride out.
 */
export type ObservationEnd = 'done' | 'expired' | 'stalled' | 'failed';

/**
 * The one classification of "keep polling past this capture error": the content was not readable
 * on this poll (an Android helper content verdict), or the producer itself typed the refusal as
 * retriable (a busy iOS runner draining abandoned work). Everything else ends the loop.
 */
export function isRideOutCaptureError(error: unknown): boolean {
  if (isUnreadableCaptureContentError(error)) return true;
  return error instanceof AppError && error.details?.retriable === true;
}
