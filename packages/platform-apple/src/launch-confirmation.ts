import type { LaunchConfirmation } from '@agent-device/contracts/application-lifecycle-runtime';
import type { Interactor } from '@agent-device/contracts/interactor-types';
import { invalidRuntimeContract } from '@agent-device/contracts/runtime-contract-error';
import { emitDiagnostic } from '@agent-device/host-kit/diagnostics';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import { isAlertNotFoundError } from './alert.ts';
import { resolveIosSimulatorDeepLinkBundleId } from './core/app-resolution.ts';

export const LAUNCH_CONFIRMATION_FOREIGN_APP_REASON = 'launch_confirmation_foreign_app';

/** SpringBoard's title for a URL it holds until the user confirms the app that will open it. */
const LAUNCH_CONFIRMATION_TITLE = /^Open in [“"].+[”"]\?$/u;

/** A custom-scheme launch URL SpringBoard may hold for the session app it was checked for. */
export type LaunchConfirmationTarget = Readonly<{ url: string; appBundleId: string }>;

/** The device reads and the answer one launch confirmation needs, bound to the session app. */
export type LaunchConfirmationPort = Readonly<{
  appBundleId: string;
  readAlert(): Promise<Record<string, unknown>>;
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
  const alert = await port.readAlert().catch((error: unknown) => {
    if (!isAlertNotFoundError(error)) reportFailed('alert-read', error);
    return undefined;
  });
  if (!alert || !isLaunchConfirmation(alert)) return undefined;
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

export function createLaunchConfirmationPort(
  device: DeviceInfo,
  { url, appBundleId }: LaunchConfirmationTarget,
  resolveInteractor: () => Promise<Interactor>,
): LaunchConfirmationPort {
  const target = { appBundleId, surface: 'app' } as const;
  const alertLegs = async () => {
    const interactor = await resolveInteractor();
    const { readAlert, acceptAlert } = interactor;
    if (!readAlert || !acceptAlert) {
      throw invalidRuntimeContract('Apple interactor has no alert read or accept leg');
    }
    return {
      read: () => readAlert.call(interactor, target),
      accept: () => acceptAlert.call(interactor, target),
    };
  };
  return Object.freeze({
    appBundleId,
    readAlert: async () => await (await alertLegs()).read(),
    acceptAlert: async () => await (await alertLegs()).accept(),
    resolveUrlOwner: async () => await resolveIosSimulatorDeepLinkBundleId(device, url),
  });
}
