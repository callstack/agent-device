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

/** The device reads and the answer one launch confirmation needs, bound to the session app. */
export type LaunchConfirmationPort = Readonly<{
  appBundleId: string;
  readAlert(): Promise<Record<string, unknown>>;
  acceptAlert(): Promise<unknown>;
  /** The installed app that owns the launch URL's scheme, when exactly one does. */
  resolveUrlOwner(): Promise<string | undefined>;
}>;

type Leg = 'alert-read' | 'url-owner' | 'alert-accept';

/**
 * Answers a launch confirmation within `budgetMs`, shared by the alert read, the URL owner lookup
 * and the accept. The title only recognizes the confirmation; the app it opens is the URL scheme's
 * owner. An owner that is the session app is accepted; any other owner is never accepted and fails
 * the open, because accepting would hand it the launch URL. Anything else (no alert, another alert,
 * an owner no single installed app is, a failed or late leg) leaves the open as it was.
 */
export async function answerLaunchConfirmation(
  port: LaunchConfirmationPort,
  budgetMs: number,
): Promise<LaunchConfirmation | undefined> {
  const deadline = Date.now() + budgetMs;
  const alert = await runLeg('alert-read', port.readAlert(), deadline);
  if (!alert.settled || !isLaunchConfirmation(alert.value)) return undefined;
  const owner = await runLeg('url-owner', port.resolveUrlOwner(), deadline);
  if (!owner.settled) return undefined;
  if (owner.value === undefined) {
    reportUnanswered('url-owner-unresolved', {});
    return undefined;
  }
  if (owner.value !== port.appBundleId) {
    throw new AppError('COMMAND_FAILED', `The launch URL asks to open ${owner.value} instead.`, {
      reason: LAUNCH_CONFIRMATION_FOREIGN_APP_REASON,
      foreignAppBundleId: owner.value,
      sessionAppBundleId: port.appBundleId,
      hint: `iOS is asking whether to open ${owner.value}. Answer it with alert accept or alert dismiss, and pass a launch URL whose scheme belongs to the session app.`,
    });
  }
  const accepted = await runLeg('alert-accept', port.acceptAlert(), deadline);
  return accepted.settled ? 'accepted' : undefined;
}

function isLaunchConfirmation(alert: Record<string, unknown>): boolean {
  const title = alert['message'];
  return typeof title === 'string' && LAUNCH_CONFIRMATION_TITLE.test(title);
}

/** A leg's value within what is left of the budget; a failure or a late settle is reported. */
async function runLeg<T>(
  leg: Leg,
  operation: Promise<T>,
  deadline: number,
): Promise<Readonly<{ settled: true; value: T }> | Readonly<{ settled: false }>> {
  operation.catch(() => {});
  let cancelExpiry = () => {};
  const expired = new Promise<'expired'>((resolve) => {
    const timer = setTimeout(() => resolve('expired'), Math.max(0, deadline - Date.now()));
    cancelExpiry = () => clearTimeout(timer);
  });
  try {
    const outcome = await Promise.race([
      operation.then((value) => ({ settled: true, value }) as const),
      expired,
    ]);
    if (outcome !== 'expired') return outcome;
    reportUnanswered('budget-spent', { leg });
  } catch (error) {
    if (!(leg === 'alert-read' && isAlertNotFoundError(error))) {
      reportUnanswered('leg-failed', {
        leg,
        code: error instanceof AppError ? error.code : undefined,
      });
    }
  } finally {
    cancelExpiry();
  }
  return { settled: false };
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
  appBundleId: string,
  launchUrl: string,
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
    resolveUrlOwner: async () => await resolveIosSimulatorDeepLinkBundleId(device, launchUrl),
  });
}
