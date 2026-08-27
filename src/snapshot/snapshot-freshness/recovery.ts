import {
  snapshotCaptureAnnotationsFrom,
  type SnapshotCaptureAnnotations,
} from '@agent-device/contracts/capture';
import type { SnapshotState } from '@agent-device/kernel/snapshot';
import { sleep } from '@agent-device/host-kit/retry';
import type { SnapshotFreshnessReason, SnapshotFreshnessWindow } from './types.ts';

/**
 * How long retries may continue, and what to wait between them. Both are policy inputs rather
 * than constants here, because "how long may a backend lag behind a real transition" is a
 * property of the acquisition backend, not of the recovery loop.
 *
 * Both fields are durations. The loop derives the actual deadline from the window's `markedAt`
 * itself, so the budget is always spent from the action rather than from whenever the first
 * capture happened to return, and a caller has no absolute instant it could get wrong.
 */
export type SnapshotFreshnessRetrySchedule = {
  retryBudgetMs: number;
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
  // Derived here, never accepted from the caller: the budget runs from the action that opened
  // the window, so time already spent inside the first capture is time the retries do not get.
  const retryUntilMs = params.window.markedAt + params.retry.retryBudgetMs;

  let latest = await params.capture();
  let suspiciousReason = params.classify(latest);
  let retryCount = 0;

  for (const delayMs of params.retry.delaysMs) {
    if (!suspiciousReason) break;
    const remainingMs = retryUntilMs - Date.now();
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
