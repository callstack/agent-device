import type { AndroidObservationAdapter } from '@agent-device/contracts/android-observation';
import { AppError } from '@agent-device/kernel/errors';
import {
  detectAndroidEscapeSurface,
  looksLikeAndroidEscapeSurface,
} from '../../android-foreground-surface.ts';
import type { SessionState } from '../../../core/session-state.ts';

/**
 * Post-touch escape guard. Throws when a touch left the session app for an escape surface
 * (settings/systemui/launcher), unless an escape surface other than the session app already owned
 * the focus before the dispatch.
 * A raised permission prompt is not an escape: it returns a response warning for `alert` instead.
 */
export async function assertAndroidPressStayedInApp(
  session: SessionState,
  touch: { command: string; targetLabel: string; focusedPackageBefore?: string },
  observation?: AndroidObservationAdapter,
): Promise<string | undefined> {
  // CONSERVATIVE: an unread pre-dispatch focus runs the guard; it is no evidence that an escape
  // surface owned the focus. Revisit if every readiness read names the focused package.
  const { focusedPackageBefore } = touch;
  if (
    focusedPackageBefore !== undefined &&
    focusedPackageBefore !== session.appBundleId &&
    looksLikeAndroidEscapeSurface(focusedPackageBefore)
  ) {
    return undefined;
  }
  const surface = await detectAndroidEscapeSurface(session, observation);
  if (!surface) return undefined;

  if (surface.permissionDialog) {
    return `${touch.command} ${touch.targetLabel} opened an Android permission dialog (${surface.foregroundPackage}) over ${surface.expectedPackage}. ${surface.hint}`;
  }

  throw new AppError(
    'COMMAND_FAILED',
    `${touch.command} ${touch.targetLabel} left ${session.appBundleId} and foregrounded ${surface.foregroundPackage}. The tap likely escaped the app.`,
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
