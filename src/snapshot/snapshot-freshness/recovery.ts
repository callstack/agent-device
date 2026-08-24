import {
  snapshotCaptureAnnotationsFrom,
  type SnapshotCaptureAnnotations,
} from '@agent-device/contracts/capture';
import type { SnapshotState } from '@agent-device/kernel/snapshot';
import { sleep } from '../../utils/timeouts.ts';
import type { SnapshotFreshnessReason, SnapshotFreshnessWindow } from './types.ts';

/**
 * When to stop retrying, and what to wait between attempts. Both are policy inputs rather than
 * constants here, because "how long may a backend lag behind a real transition" is a property of
 * the acquisition backend, not of the recovery loop.
 *
 * `retryUntilMs` is an absolute `Date.now()` instant, NOT a duration — it is the window's
 * `markedAt` plus the backend's retry budget, so the budget is spent from the action rather than
 * from whenever the first capture happened to return. Passing a bare duration here would type-check
 * and then silently run zero retries, so the name says which one it is.
 */
export type SnapshotFreshnessRetrySchedule = {
  retryUntilMs: number;
  delaysMs: readonly number[];
};

export type SnapshotFreshnessAttemptShape = {
  snapshot: SnapshotState;
  annotations: SnapshotCaptureAnnotations;
};

/**
 * The whole freshness recovery: re-capture past suspicious dumps until the
 * capture stops matching a staleness shape or the post-action deadline
 * expires, then annotate what happened. `onTrustworthyCapture` fires only when
 * a trustworthy capture was seen, so the caller can retire its window; a
 * still-suspicious final attempt leaves the window standing so the next capture
 * can try again, and the annotation discloses `staleAfterRetries` to the caller.
 */
export async function captureFreshnessRecoveredAttempt<
  T extends SnapshotFreshnessAttemptShape,
>(params: {
  capture: () => Promise<T>;
  classify: (attempt: T) => SnapshotFreshnessReason | null;
  window: SnapshotFreshnessWindow;
  retry: SnapshotFreshnessRetrySchedule;
  onTrustworthyCapture?: () => void;
}): Promise<T> {
  let latest = await params.capture();
  let suspiciousReason = params.classify(latest);
  let retryCount = 0;

  for (const delayMs of params.retry.delaysMs) {
    if (!suspiciousReason) break;
    const remainingMs = params.retry.retryUntilMs - Date.now();
    if (remainingMs <= 0) break;
    await sleep(Math.min(delayMs, remainingMs));
    latest = await params.capture();
    retryCount += 1;
    suspiciousReason = params.classify(latest);
  }

  if (!suspiciousReason) {
    params.onTrustworthyCapture?.();
  }

  const freshnessAnnotation =
    retryCount > 0 || Boolean(suspiciousReason)
      ? {
          action: params.window.action,
          retryCount,
          staleAfterRetries: Boolean(suspiciousReason),
          reason: suspiciousReason ?? undefined,
        }
      : undefined;
  return {
    ...latest,
    annotations: {
      ...latest.annotations,
      ...snapshotCaptureAnnotationsFrom({ freshness: freshnessAnnotation }),
    },
  };
}
