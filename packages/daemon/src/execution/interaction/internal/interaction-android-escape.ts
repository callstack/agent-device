import type { AndroidObservationAdapter } from '@agent-device/contracts/android-observation';
import { AppError } from '@agent-device/kernel/errors';
import {
  detectAndroidEscapeSurface,
  looksLikeAndroidEscapeSurface,
} from '../../android-foreground-surface.ts';
import type { SessionState } from '../../../core/session-state.ts';

/**
 * Post-press escape guard. Throws when a touch dispatched while the session app owned the focus
 * left the app for a genuine escape surface (settings/systemui/launcher). A touch dispatched while an
 * escape surface already owned the focus (the launcher after `home`) acted on that surface, so it
 * cannot escape the app. Other packages that own the focus inside an app flow (a permission prompt,
 * a custom tab, a sign-in activity) do not skip the guard. A foregrounded permission prompt is NOT an escape — the press succeeded and
 * raised a system dialog the agent consumes via `alert` — so it returns a response warning instead.
 */
export async function assertAndroidPressStayedInApp(
  session: SessionState,
  touch: { command: string; targetLabel: string; focusedPackageBefore?: string },
  observation?: AndroidObservationAdapter,
): Promise<string | undefined> {
  // CONSERVATIVE: an unread pre-dispatch focus still runs the guard, because it is no evidence that
  // the app was in the background. Revisit if every readiness read names the focused package.
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
