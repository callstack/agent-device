import type { LaunchConfirmation } from '@agent-device/contracts/application-lifecycle-runtime';
import type { Interactor } from '@agent-device/contracts/interactor-types';
import { invalidRuntimeContract } from '@agent-device/contracts/runtime-contract-error';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import { isAlertNotFoundError } from './alert.ts';
import { listIosApps } from './core/app-resolution.ts';

export const LAUNCH_CONFIRMATION_FOREIGN_APP_REASON = 'launch_confirmation_foreign_app';

/** SpringBoard's title for a URL it holds until the user confirms the app that will open it. */
const LAUNCH_CONFIRMATION_TITLE = /^Open in [“"](.+)[”"]\?$/u;

/** The device reads one launch confirmation answer needs, bound to the session app. */
export type LaunchConfirmationPort = Readonly<{
  appBundleId: string;
  readAlert(): Promise<Record<string, unknown>>;
  acceptAlert(): Promise<unknown>;
  readSessionAppName(): Promise<string | undefined>;
}>;

/**
 * Reads the alert once. No alert, or an alert that is not a launch confirmation, leaves the open
 * as it was. A confirmation naming the session app is accepted; one naming any other app is never
 * accepted and fails the open, because accepting it would hand the launch URL to that app.
 */
export async function answerLaunchConfirmation(
  port: LaunchConfirmationPort,
): Promise<LaunchConfirmation | undefined> {
  const namedApp = await readConfirmationAppName(port);
  if (namedApp === undefined) return undefined;
  const sessionAppName = await port.readSessionAppName();
  if (namedApp !== sessionAppName) {
    throw new AppError('COMMAND_FAILED', `The launch URL asks to open "${namedApp}" instead.`, {
      reason: LAUNCH_CONFIRMATION_FOREIGN_APP_REASON,
      appName: namedApp,
      appBundleId: port.appBundleId,
      ...(sessionAppName === undefined ? {} : { sessionAppName }),
      hint: `iOS is asking whether to open "${namedApp}". Answer it with alert accept or alert dismiss, and pass a launch URL whose scheme belongs to the session app.`,
    });
  }
  await port.acceptAlert();
  return 'accepted';
}

async function readConfirmationAppName(port: LaunchConfirmationPort): Promise<string | undefined> {
  let alert: Record<string, unknown>;
  try {
    alert = await port.readAlert();
  } catch (error) {
    if (isAlertNotFoundError(error)) return undefined;
    throw error;
  }
  const title = alert['message'];
  return typeof title === 'string' ? LAUNCH_CONFIRMATION_TITLE.exec(title)?.[1] : undefined;
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
    readSessionAppName: async () =>
      (await listIosApps(device, 'all')).find((app) => app.bundleId === appBundleId)?.name,
  });
}
