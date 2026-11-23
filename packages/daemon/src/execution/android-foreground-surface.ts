import type { AndroidObservationAdapter } from '@agent-device/contracts/android-observation';
import { AppError } from '@agent-device/kernel/errors';
import { sleep } from '@agent-device/host-kit/retry';
import { isActiveProviderDevice } from '../core/provider-device-admission.ts';
import type { SessionState } from '../core/session-state.ts';

export type AndroidEscapeSurface = {
  expectedPackage: string;
  foregroundPackage: string;
  activity?: string;
  hint: string;
  permissionDialog?: boolean;
};

export type AndroidEscapeSurfaceOptions = Readonly<{
  /**
   * Wait this long before the first foreground read. A touch that opens another app flips the
   * focused window only after the app transition lands, so an immediate read names the old
   * package and judges the pre-transition state. Callers that judge a completed press set this;
   * error-path annotators read immediately and do not pay the wait.
   */
  settleMs?: number;
  /**
   * The dispatching request's abort signal. A deadline that fires during the settle interrupts the
   * wait and fails the guard, instead of leaving a canceled request an observation read.
   */
  signal?: AbortSignal;
  /**
   * The dispatching request's deadline. The settle never extends past it: with less than
   * `settleMs` left, the wait is the remainder, and a spent deadline schedules no timer.
   */
  deadlineAtMs?: number;
}>;

export async function detectAndroidEscapeSurface(
  session: SessionState,
  observation?: AndroidObservationAdapter,
  options?: AndroidEscapeSurfaceOptions,
): Promise<AndroidEscapeSurface | null> {
  if (
    session.device.platform !== 'android' ||
    !session.appBundleId ||
    session.lease?.leaseProvider ||
    isActiveProviderDevice(session.device)
  ) {
    return null;
  }

  if (!observation) {
    throw new AppError(
      'INTERNAL_ERROR',
      'Android observation was not supplied by root runtime composition',
    );
  }

  // Behind the gates above, so only a session about to be read pays the wait. The wait clamps to
  // the request's remaining deadline (the sleepWithinDeadline clamp) and rides its abort signal,
  // so a deadline firing during the settle cancels the guard instead of holding the step past the
  // request's budget.
  if (options?.settleMs) {
    const settleMs =
      options.deadlineAtMs === undefined
        ? options.settleMs
        : Math.min(options.settleMs, options.deadlineAtMs - Date.now());
    if (settleMs > 0) await sleep(settleMs, options.signal);
    options.signal?.throwIfAborted();
  }

  if (await observation.readAppFocus(session.device, session.appBundleId)) return null;
  const foreground = await observation.readAppState(session.device);
  const foregroundPackage = foreground.package?.trim();
  if (!foregroundPackage || foregroundPackage === session.appBundleId) return null;
  const permissionDialog = await observation.isPermissionPackage(foregroundPackage);
  if (!looksLikeAndroidEscapeSurface(foregroundPackage) && !permissionDialog) return null;

  return {
    expectedPackage: session.appBundleId,
    foregroundPackage,
    activity: foreground.activity,
    hint: buildAndroidEscapeHint(permissionDialog),
    ...(permissionDialog ? { permissionDialog: true } : {}),
  };
}

export function describeAndroidEscapeSurface(surface: AndroidEscapeSurface): string {
  if (surface.permissionDialog) {
    return `Android permission dialog is blocking ${surface.expectedPackage}`;
  }
  return `${surface.foregroundPackage} is foreground instead of ${surface.expectedPackage}`;
}

function buildAndroidEscapeHint(permissionDialog: boolean): string {
  if (permissionDialog) {
    return 'Use "alert get" to inspect it, then "alert accept" or "alert dismiss" to respond.';
  }
  return 'Use screenshot as visual truth, then take a fresh snapshot -i before retrying.';
}

export function looksLikeAndroidEscapeSurface(packageName: string): boolean {
  return (
    packageName === 'com.android.settings' ||
    packageName === 'com.android.systemui' ||
    packageName.includes('launcher')
  );
}
