import type {
  PostOpenObservation,
  PostOpenObservationFailure,
} from '@agent-device/contracts/application-lifecycle-runtime';
import {
  isUnreadableCaptureContentError,
  readAndroidCaptureFailureReason,
} from '@agent-device/contracts/android-snapshot-quality';
import type { Interactor } from '@agent-device/contracts/interactor-types';
import { normalizeError } from '@agent-device/kernel/errors';

/**
 * Longer than the unmounted window measured after `am start -W` on a loaded emulator (up to 5.4 s).
 * It only stops further re-captures; helper start and capture keep their own budgets.
 */
export const ANDROID_LAUNCH_SETTLE_WINDOW_MS = 6_000;

export type AndroidLaunchObservation =
  | Readonly<{ observation: Extract<PostOpenObservation, 'observable' | 'unobservable'> }>
  | Readonly<{ observation: 'probe-failed'; failure: PostOpenObservationFailure }>;

/**
 * `am start -W` returns at the first frame, which can precede the app's mounted views. This
 * captures the launched app transiently and lets the capture's content verdict and re-captures
 * decide readiness. Only a content verdict or a system surface over the app reads as
 * `unobservable`; any other capture failure is `probe-failed` with its typed reason. Only the
 * caller's signal cancels the capture.
 */
export async function observeAndroidLaunch(
  interactor: Pick<Interactor, 'snapshot'>,
  appBundleId: string,
  signal: AbortSignal,
): Promise<AndroidLaunchObservation> {
  try {
    const capture = await interactor.snapshot({
      appBundleId,
      signal,
      transient: { settleBy: Date.now() + ANDROID_LAUNCH_SETTLE_WINDOW_MS },
    });
    const systemSurfaceOnly =
      'androidSnapshot' in capture && capture.androidSnapshot?.systemSurfaceOnly === true;
    return { observation: systemSurfaceOnly ? 'unobservable' : 'observable' };
  } catch (error) {
    signal.throwIfAborted();
    if (isUnreadableCaptureContentError(error)) return { observation: 'unobservable' };
    return { observation: 'probe-failed', failure: typedFailure(error) };
  }
}

function typedFailure(error: unknown): PostOpenObservationFailure {
  const normalized = normalizeError(error);
  const reason = readAndroidCaptureFailureReason(normalized) ?? normalized.details?.reason;
  return typeof reason === 'string' ? { code: normalized.code, reason } : { code: normalized.code };
}
