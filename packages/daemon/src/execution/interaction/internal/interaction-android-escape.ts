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
  touch: {
    command: string;
    targetLabel: string;
    /** The package the pre-dispatch readiness read named, when it named one. */
    focusedPackageBefore?: string;
    /** The package the post-dispatch readiness read named, when it named one. */
    focusedPackageAfter?: string;
  },
  observation?: AndroidObservationAdapter,
): Promise<string | undefined> {
  // CONSERVATIVE: an unread pre-dispatch focus runs the guard; it is no evidence that an escape
  // surface owned the focus. Revisit if every readiness read names the focused package.
  const { focusedPackageBefore, focusedPackageAfter } = touch;
  if (
    focusedPackageBefore !== undefined &&
    focusedPackageBefore !== session.appBundleId &&
    looksLikeAndroidEscapeSurface(focusedPackageBefore)
  ) {
    return undefined;
  }
  // A post-dispatch read that names another app is a confirmed escape: the transition already
  // landed, so this decides with it and spends no read of its own. A read that names the session
  // app is NOT that evidence — a touch that opens another app flips the focused window only once
  // the app transition lands, so the read can predate the switch it failed to see. Same-app and
  // unread evidence therefore fall through to the guard's own read, which now runs after the
  // readiness read and so samples the transition later than either.
  const confirmedOutsideApp =
    focusedPackageAfter !== undefined && focusedPackageAfter !== session.appBundleId;
  const surface = await detectAndroidEscapeSurface(
    session,
    observation,
    confirmedOutsideApp ? { focusOutsideApp: focusedPackageAfter } : undefined,
  );
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
