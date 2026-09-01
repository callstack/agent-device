import type { AndroidObservationAdapter } from '@agent-device/contracts/android-observation';
import { AppError } from '@agent-device/kernel/errors';
import { detectAndroidEscapeSurface } from '../../android-foreground-surface.ts';
import type { SessionState } from '../../types.ts';

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

export function isAndroidEscapeError(error: AppError): boolean {
  return (
    error.code === 'COMMAND_FAILED' &&
    typeof error.details?.expectedPackage === 'string' &&
    typeof error.details?.foregroundPackage === 'string'
  );
}
