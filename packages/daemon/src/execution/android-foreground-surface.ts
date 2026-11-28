import type { AndroidObservationAdapter } from '@agent-device/contracts/android-observation';
import { AppError } from '@agent-device/kernel/errors';
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
   * The package a read taken after the action named, when it named one other than the session app.
   * That read is the evidence this judges on, so the observer spends no read of its own. A read
   * that named the session app is NOT passed: an action that opens another app flips the focused
   * window only once the app transition lands, so a read may still name the app after the escape
   * was already under way, and passing it would judge the transition by its own stale answer.
   */
  focusOutsideApp?: string;
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

  let foregroundPackage: string | undefined;
  let activity: string | undefined;
  if (options?.focusOutsideApp !== undefined) {
    foregroundPackage = options.focusOutsideApp;
  } else {
    if (await observation.readAppFocus(session.device, session.appBundleId)) return null;
    const foreground = await observation.readAppState(session.device);
    foregroundPackage = foreground.package;
    activity = foreground.activity;
  }
  foregroundPackage = foregroundPackage?.trim();
  if (!foregroundPackage || foregroundPackage === session.appBundleId) return null;
  const permissionDialog = await observation.isPermissionPackage(foregroundPackage);
  if (!looksLikeAndroidEscapeSurface(foregroundPackage) && !permissionDialog) return null;

  return {
    expectedPackage: session.appBundleId,
    foregroundPackage,
    ...(activity ? { activity } : {}),
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
