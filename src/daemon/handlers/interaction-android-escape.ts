import { getAndroidAppState } from '../../platforms/android/app-lifecycle.ts';
import { AppError } from '../../kernel/errors.ts';
import type { SessionState } from '../types.ts';

export type AndroidEscapeSurface = {
  expectedPackage: string;
  foregroundPackage: string;
  activity?: string;
  hint: string;
};

export async function assertAndroidPressStayedInApp(
  session: SessionState,
  targetLabel: string,
): Promise<void> {
  const surface = await detectAndroidEscapeSurface(session);
  if (!surface) return;

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
  if (surface.foregroundPackage === 'com.google.android.permissioncontroller') {
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
  if (packageName === 'com.google.android.permissioncontroller') {
    return 'Dismiss or allow the permission prompt, then retry the smoke assertion.';
  }
  return 'Use screenshot as visual truth, then take a fresh snapshot -i before retrying.';
}

function looksLikeAndroidEscapeSurface(packageName: string): boolean {
  return (
    packageName === 'com.android.settings' ||
    packageName === 'com.android.systemui' ||
    packageName === 'com.google.android.permissioncontroller' ||
    packageName.includes('launcher')
  );
}
