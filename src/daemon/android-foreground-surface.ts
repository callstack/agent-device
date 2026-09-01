import type { AndroidObservationAdapter } from '@agent-device/contracts/android-observation';
import { AppError } from '@agent-device/kernel/errors';
import { isActiveProviderDevice } from '../provider-device-runtime.ts';
import type { SessionState } from './types.ts';

export type AndroidEscapeSurface = {
  expectedPackage: string;
  foregroundPackage: string;
  activity?: string;
  hint: string;
  permissionDialog?: boolean;
};

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
