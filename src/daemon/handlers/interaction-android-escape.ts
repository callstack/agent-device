import type { AndroidObservationAdapter } from '@agent-device/contracts/android-observation';
import { AppError } from '@agent-device/kernel/errors';
import { isActiveProviderDevice } from '../../provider-device-runtime.ts';
import type { SessionState } from '../types.ts';

export type AndroidEscapeSurface = {
  expectedPackage: string;
  foregroundPackage: string;
  activity?: string;
  hint: string;
  permissionDialog?: boolean;
};

/**
 * Post-press escape guard. Throws when the tap left the app for a genuine
 * escape surface (settings/systemui/launcher). A foregrounded permission
 * prompt is NOT an escape — the press succeeded and raised a system dialog
 * the agent consumes via `alert` — so it returns a response warning instead.
 */
export async function assertAndroidPressStayedInApp(
  session: SessionState,
  targetLabel: string,
  observation?: AndroidObservationAdapter,
): Promise<string | undefined> {
  const surface = await detectAndroidEscapeSurface(session, observation);
  if (!surface) return undefined;

  if (surface.permissionDialog) {
    return `press ${targetLabel} opened an Android permission dialog (${surface.foregroundPackage}) over ${surface.expectedPackage}. ${surface.hint}`;
  }

  throw new AppError(
    'COMMAND_FAILED',
    `press ${targetLabel} left ${session.appBundleId} and foregrounded ${surface.foregroundPackage}. The tap likely escaped the app.`,
    surface,
  );
}

export async function detectAndroidEscapeSurface(
  session: SessionState,
  observation?: AndroidObservationAdapter,
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

export function isAndroidEscapeError(error: AppError): boolean {
  return (
    error.code === 'COMMAND_FAILED' &&
    typeof error.details?.expectedPackage === 'string' &&
    typeof error.details?.foregroundPackage === 'string'
  );
}

function buildAndroidEscapeHint(permissionDialog: boolean): string {
  if (permissionDialog) {
    return 'Use "alert get" to inspect it, then "alert accept" or "alert dismiss" to respond.';
  }
  return 'Use screenshot as visual truth, then take a fresh snapshot -i before retrying.';
}

function looksLikeAndroidEscapeSurface(packageName: string): boolean {
  return (
    packageName === 'com.android.settings' ||
    packageName === 'com.android.systemui' ||
    packageName.includes('launcher')
  );
}
