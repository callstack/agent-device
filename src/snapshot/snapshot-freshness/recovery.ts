import {
  snapshotCaptureAnnotationsFrom,
  type SnapshotCaptureAnnotations,
} from '@agent-device/contracts/capture';
import type { SnapshotState } from '@agent-device/kernel/snapshot';
import { sleep } from '../../utils/timeouts.ts';
import type { SnapshotFreshnessReason, SnapshotFreshnessWindow } from './types.ts';

/**
 * When to stop retrying: an absolute post-action deadline plus the delays to try before it.
 * Both are policy inputs rather than constants here, because "how long may a backend lag behind
 * a real transition" is a property of the acquisition backend, not of the recovery loop.
 */
export type SnapshotFreshnessRetrySchedule = {
  deadlineMs: number;
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
    const remainingMs = params.retry.deadlineMs - Date.now();
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
