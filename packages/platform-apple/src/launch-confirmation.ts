import type { LaunchConfirmation } from '@agent-device/contracts/application-lifecycle-runtime';
import type { Interactor } from '@agent-device/contracts/interactor-types';
import { invalidRuntimeContract } from '@agent-device/contracts/runtime-contract-error';
import { emitDiagnostic } from '@agent-device/host-kit/diagnostics';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import { isAlertNotFoundError } from './alert.ts';
import { listIosApps } from './core/app-resolution.ts';

export const LAUNCH_CONFIRMATION_FOREIGN_APP_REASON = 'launch_confirmation_foreign_app';

/** SpringBoard's title for a URL it holds until the user confirms the app that will open it. */
const LAUNCH_CONFIRMATION_TITLE = /^Open in [“"](.+)[”"]\?$/u;

type InstalledApp = Readonly<{ bundleId: string; name: string }>;

/** The device reads one launch confirmation answer needs, bound to the session app. */
export type LaunchConfirmationPort = Readonly<{
  appBundleId: string;
  readAlert(): Promise<Record<string, unknown>>;
  acceptAlert(): Promise<unknown>;
  listInstalledApps(): Promise<readonly InstalledApp[]>;
}>;

/**
 * Reads the alert once within `budgetMs`. Anything but a launch confirmation read in time (no
 * alert, another alert, a failed read, a spent budget) leaves the open as it was. The name in the
 * confirmation must resolve to exactly one installed app: the session app is accepted; any other
 * app is never accepted and fails the open, because accepting would hand it the launch URL. A name
 * that no installed app or several installed apps carry cannot be attributed, so it is left
 * unanswered.
 */
export async function answerLaunchConfirmation(
  port: LaunchConfirmationPort,
  budgetMs: number,
): Promise<LaunchConfirmation | undefined> {
  const namedApp = await readConfirmationAppName(port, budgetMs);
  if (namedApp === undefined) return undefined;
  const owners = (await port.listInstalledApps()).filter((app) => app.name === namedApp);
  const [owner] = owners;
  if (owners.length !== 1 || !owner) {
    reportUnanswered('unattributable-app', { appName: namedApp, installedMatches: owners.length });
    return undefined;
  }
  if (owner.bundleId !== port.appBundleId) {
    throw new AppError('COMMAND_FAILED', `The launch URL asks to open "${namedApp}" instead.`, {
      reason: LAUNCH_CONFIRMATION_FOREIGN_APP_REASON,
      appName: namedApp,
      foreignAppBundleId: owner.bundleId,
      sessionAppBundleId: port.appBundleId,
      hint: `iOS is asking whether to open "${namedApp}". Answer it with alert accept or alert dismiss, and pass a launch URL whose scheme belongs to the session app.`,
    });
  }
  await port.acceptAlert();
  return 'accepted';
}

async function readConfirmationAppName(
  port: LaunchConfirmationPort,
  budgetMs: number,
): Promise<string | undefined> {
  let alert: Record<string, unknown> | undefined;
  try {
    alert = await settleWithin(port.readAlert(), budgetMs);
  } catch (error) {
    if (!isAlertNotFoundError(error)) {
      reportUnanswered('alert-read-failed', {
        code: error instanceof AppError ? error.code : undefined,
      });
    }
    return undefined;
  }
  if (alert === undefined) {
    reportUnanswered('launch-budget-spent', { budgetMs });
    return undefined;
  }
  const title = alert['message'];
  return typeof title === 'string' ? LAUNCH_CONFIRMATION_TITLE.exec(title)?.[1] : undefined;
}

/** The operation's value, or `undefined` once `budgetMs` passes first; a late settle is dropped. */
async function settleWithin<T>(operation: Promise<T>, budgetMs: number): Promise<T | undefined> {
  operation.catch(() => {});
  let cancelExpiry = () => {};
  const expired = new Promise<undefined>((resolve) => {
    const timer = setTimeout(() => resolve(undefined), Math.max(0, budgetMs));
    cancelExpiry = () => clearTimeout(timer);
  });
  try {
    return await Promise.race([operation, expired]);
  } finally {
    cancelExpiry();
  }
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
  interactor: Interactor,
): LaunchConfirmationPort {
  const { readAlert, acceptAlert } = interactor;
  if (!readAlert || !acceptAlert) {
    throw invalidRuntimeContract('Apple interactor has no alert read or accept leg');
  }
  const target = { appBundleId, surface: 'app' } as const;
  return Object.freeze({
    appBundleId,
    readAlert: async () => await readAlert.call(interactor, target),
    acceptAlert: async () => await acceptAlert.call(interactor, target),
    listInstalledApps: async () => await listIosApps(device, 'all'),
  });
}
