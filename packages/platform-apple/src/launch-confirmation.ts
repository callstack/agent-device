import type { LaunchConfirmation } from '@agent-device/contracts/application-lifecycle-runtime';
import type { Interactor } from '@agent-device/contracts/interactor-types';
import { invalidRuntimeContract } from '@agent-device/contracts/runtime-contract-error';
import { emitDiagnostic } from '@agent-device/host-kit/diagnostics';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import { alertIfPresent } from './alert.ts';
import { resolveIosSimulatorDeepLinkBundleId } from './core/app-resolution.ts';

export const LAUNCH_CONFIRMATION_FOREIGN_APP_REASON = 'launch_confirmation_foreign_app';

/**
 * SpringBoard's English title for a URL it holds until the user confirms the app that will open
 * it. The runner reports an alert only as its localized title and button labels, and a name match
 * is unsafe (a permission alert names the app too), so a Simulator in another language is not
 * recognized; the unrecognized alert is reported instead.
 */
const LAUNCH_CONFIRMATION_TITLE = /^Open in [“"].+[”"]\?$/u;

/**
 * One shared deadline for the URL-owner lookup (the app listing and every Info.plist read). The
 * alert read and accept are each bounded by the runner's `DEFAULT_ALERT_TIMEOUT_MS`; the lookup gets
 * the same bound, well inside `IOS_APP_LAUNCH_TIMEOUT_MS`, so a wedged CoreSimulator leaves the open
 * unanswered instead of holding it.
 */
export const URL_OWNER_LOOKUP_TIMEOUT_MS = 10_000;

/** A custom-scheme launch URL SpringBoard may hold for the session app it was checked for. */
export type LaunchConfirmationTarget = Readonly<{ url: string; appBundleId: string }>;

/** The device reads and the answer one launch confirmation needs, bound to the session app. */
export type LaunchConfirmationPort = Readonly<{
  appBundleId: string;
  /** The alert on screen, or `undefined` when there is none. */
  readAlert(): Promise<Record<string, unknown> | undefined>;
  acceptAlert(): Promise<unknown>;
  /** The installed app that owns the launch URL's scheme, when exactly one does. */
  resolveUrlOwner(): Promise<string | undefined>;
}>;

/**
 * Answers a launch confirmation. The title only recognizes the confirmation; the app it opens is
 * the URL scheme's owner. An owner that is the session app is accepted; any other owner is never
 * accepted and fails the open, because accepting would hand it the launch URL. Anything else (no
 * alert, another alert, an owner no single installed app is, a failed read, lookup or accept)
 * leaves the open as it was. Each step is bounded by its own timeout, so nothing outlives the
 * answer.
 */
export async function answerLaunchConfirmation(
  port: LaunchConfirmationPort,
): Promise<LaunchConfirmation | undefined> {
  const alert = await port.readAlert().catch(failed('alert-read'));
  if (!alert) return undefined;
  if (!isLaunchConfirmation(alert)) {
    emitDiagnostic({
      level: 'warn',
      phase: 'ios_launch_confirmation_unanswered',
      data: { reason: 'alert-unrecognized', title: alert['message'], buttons: alert['items'] },
    });
    return undefined;
  }
  const owner = await port.resolveUrlOwner().catch(failed('url-owner'));
  if (owner === undefined) {
    reportUnanswered('url-owner-unresolved', {});
    return undefined;
  }
  if (owner !== port.appBundleId) {
    throw new AppError('COMMAND_FAILED', `The launch URL asks to open ${owner} instead.`, {
      reason: LAUNCH_CONFIRMATION_FOREIGN_APP_REASON,
      foreignAppBundleId: owner,
      sessionAppBundleId: port.appBundleId,
      hint: `iOS is asking whether to open ${owner}. Answer it with alert accept or alert dismiss, and pass a launch URL whose scheme belongs to the session app.`,
    });
  }
  return await port.acceptAlert().then(() => 'accepted' as const, failed('alert-accept'));
}

function isLaunchConfirmation(alert: Record<string, unknown>): boolean {
  const title = alert['message'];
  return typeof title === 'string' && LAUNCH_CONFIRMATION_TITLE.test(title);
}

/** A failed step leaves the open unanswered; the failure is reported, not thrown. */
function failed(step: string): (error: unknown) => undefined {
  return (error) => reportFailed(step, error);
}

function reportFailed(step: string, error: unknown): undefined {
  reportUnanswered('step-failed', {
    step,
    code: error instanceof AppError ? error.code : undefined,
  });
  return undefined;
}

function reportUnanswered(reason: string, data: Record<string, unknown>): void {
  emitDiagnostic({
    level: 'debug',
    phase: 'ios_launch_confirmation_unanswered',
    data: { reason, ...data },
  });
}

/**
 * Answers the confirmation through the runner interactor, resolved once for the read and the
 * accept. A runner that cannot be resolved leaves the open as it was.
 */
export async function answerSimulatorLaunchConfirmation(
  device: DeviceInfo,
  confirmation: LaunchConfirmationTarget,
  interactor: Promise<Interactor>,
  signal: AbortSignal,
): Promise<LaunchConfirmation | undefined> {
  const resolved = await interactor.catch(failed('runner'));
  if (!resolved) return undefined;
  return await answerLaunchConfirmation(
    createLaunchConfirmationPort(device, confirmation, resolved, signal),
  );
}

export function createLaunchConfirmationPort(
  device: DeviceInfo,
  { url, appBundleId }: LaunchConfirmationTarget,
  interactor: Interactor,
  signal: AbortSignal,
): LaunchConfirmationPort {
  const readAlert = interactor.readAlert?.bind(interactor);
  const acceptAlert = interactor.acceptAlert?.bind(interactor);
  if (!readAlert || !acceptAlert) {
    throw invalidRuntimeContract('Apple interactor has no alert read or accept leg');
  }
  const target = { appBundleId, surface: 'app' } as const;
  return Object.freeze({
    appBundleId,
    readAlert: async () => await alertIfPresent(readAlert(target)),
    acceptAlert: async () => await acceptAlert(target),
    resolveUrlOwner: async () =>
      await resolveIosSimulatorDeepLinkBundleId(device, url, {
        timeoutMs: URL_OWNER_LOOKUP_TIMEOUT_MS,
        signal,
      }),
  });
}
