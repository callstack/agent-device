import type {
  PostOpenObservation,
  PostOpenObservationFailure,
} from '@agent-device/contracts/application-lifecycle-runtime';
import { isUnreadableCaptureContentError } from '@agent-device/contracts/android-snapshot-quality';
import type { Interactor } from '@agent-device/contracts/interactor-types';
import type { PlatformRuntimeHost } from '@agent-device/contracts/platform-runtime-operations';
import { normalizeError } from '@agent-device/kernel/errors';

/**
 * Longer than the unmounted window measured after `am start -W` on a loaded emulator (up to 5.4 s),
 * and far shorter than the open's own timeout. The window never extends.
 */
export const ANDROID_LAUNCH_OBSERVATION_WINDOW_MS = 6_000;

export type AndroidLaunchObservation =
  | Readonly<{ observation: Extract<PostOpenObservation, 'observable' | 'unobservable'> }>
  | Readonly<{ observation: 'probe-failed'; failure: PostOpenObservationFailure }>;

export type AndroidLaunchObservationPort = Readonly<{
  awaitObservable(
    interactor: Pick<Interactor, 'snapshot'>,
    appBundleId: string,
    signal: AbortSignal,
  ): Promise<AndroidLaunchObservation>;
}>;

/**
 * `am start -W` returns at the first frame, which can precede the app's mounted views. The probe
 * captures the launched app once, transiently: it borrows the helper and installs none. The
 * capture's content verdict and re-captures decide readiness within one fixed window. Only a
 * content verdict or the window running out reads as `unobservable`; any other capture failure is
 * reported as `probe-failed` with its typed reason. Cancelling the open still rejects.
 */
export function createAndroidLaunchObservationProbe(
  deps: Readonly<{ clock: PlatformRuntimeHost['clock'] }>,
): AndroidLaunchObservationPort {
  return Object.freeze({
    awaitObservable: async (interactor, appBundleId, signal) => {
      const window = new AbortController();
      const windowTimer = new AbortController();
      void deps.clock.sleep(ANDROID_LAUNCH_OBSERVATION_WINDOW_MS, windowTimer.signal).then(
        () => window.abort(),
        () => {},
      );
      try {
        const capture = await interactor.snapshot({
          appBundleId,
          signal: AbortSignal.any([signal, window.signal]),
          transient: true,
        });
        const systemSurfaceOnly =
          'androidSnapshot' in capture && capture.androidSnapshot?.systemSurfaceOnly === true;
        return { observation: systemSurfaceOnly ? 'unobservable' : 'observable' };
      } catch (error) {
        signal.throwIfAborted();
        if (window.signal.aborted || isUnreadableCaptureContentError(error)) {
          return { observation: 'unobservable' };
        }
        return { observation: 'probe-failed', failure: typedFailure(error) };
      } finally {
        windowTimer.abort();
      }
    },
  });
}

function typedFailure(error: unknown): PostOpenObservationFailure {
  const normalized = normalizeError(error);
  const details = normalized.details;
  const reason = details?.androidCaptureFailureReason ?? details?.reason;
  return typeof reason === 'string' ? { code: normalized.code, reason } : { code: normalized.code };
}
