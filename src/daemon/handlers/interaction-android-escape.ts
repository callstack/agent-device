import { getAndroidAppState } from '../../platforms/android/window-state.ts';
import { isAndroidPermissionPackage } from '../../platforms/android/alert-detection.ts';
import { AppError } from '@agent-device/kernel/errors';
import type { SessionState } from '../types.ts';

export type AndroidEscapeSurface = {
  expectedPackage: string;
  foregroundPackage: string;
  activity?: string;
  hint: string;
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
): Promise<string | undefined> {
  const surface = await detectAndroidEscapeSurface(session);
  if (!surface) return undefined;

  if (isAndroidPermissionPackage(surface.foregroundPackage)) {
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
): Promise<AndroidEscapeSurface | null> {
  if (session.device.platform !== 'android' || !session.appBundleId) return null;

  const foreground = await getAndroidAppState(session.device);
  const foregroundPackage = foreground.package?.trim();
  if (!foregroundPackage || foregroundPackage === session.appBundleId) return null;
  if (!looksLikeAndroidEscapeSurface(foregroundPackage)) return null;

  return {
    expectedPackage: session.appBundleId,
    foregroundPackage,
    activity: foreground.activity,
    hint: buildAndroidEscapeHint(foregroundPackage),
  };
}

export function describeAndroidEscapeSurface(surface: AndroidEscapeSurface): string {
  if (isAndroidPermissionPackage(surface.foregroundPackage)) {
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

function buildAndroidEscapeHint(packageName: string): string {
  if (isAndroidPermissionPackage(packageName)) {
    return 'Use "alert get" to inspect it, then "alert accept" or "alert dismiss" to respond.';
  }
  return 'Use screenshot as visual truth, then take a fresh snapshot -i before retrying.';
}

function looksLikeAndroidEscapeSurface(packageName: string): boolean {
  return (
    packageName === 'com.android.settings' ||
    packageName === 'com.android.systemui' ||
    isAndroidPermissionPackage(packageName) ||
    packageName.includes('launcher')
  );
}
