import type { Interactor } from '@agent-device/contracts/interactor-types';
import { invalidRuntimeContract } from '@agent-device/contracts/runtime-contract-error';
import { emitDiagnostic } from '@agent-device/host-kit/diagnostics';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import { alertIfPresent } from './alert.ts';
import { resolveIosSimulatorDeepLinkBundleId } from './core/app-resolution.ts';

export const LAUNCH_CONFIRMATION_FOREIGN_APP_REASON = 'launch_confirmation_foreign_app';

/**
 * How one launch-confirmation answer attempt ended. Two endings mean the launch URL left the
 * caller's hands and only that caller knows whether it landed: `accepted`, and the `unreadable`
 * whose step is `alert-accept`, where the accept was attempted and its outcome never arrived. Every
 * other ending leaves the launch exactly as it was — `absent` found no prompt, `unanswered` found a
 * prompt this answer must not accept, and any other `unreadable` step failed before one. A caller
 * acts on these outcomes and its own proof about the process, never on text.
 */
export type LaunchConfirmationAttempt =
  | Readonly<{ outcome: 'accepted' }>
  | Readonly<{ outcome: 'absent' }>
  | Readonly<{ outcome: 'unanswered'; reason: 'alert-unrecognized' | 'url-owner-unresolved' }>
  | Readonly<{ outcome: 'unreadable'; step: LaunchConfirmationStep }>;

/** A step of the answer that failed, keyed for diagnostics and tests. */
export type LaunchConfirmationStep = 'alert-read' | 'alert-accept' | 'url-owner' | 'runner';

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
 * accepted and fails the open, because accepting would hand it the launch URL. Every other ending
 * is reported as its typed attempt so the settle can decide what the launch still needs. Each step
 * is bounded by its own timeout, so nothing outlives the answer.
 */
export async function answerLaunchConfirmation(
  port: LaunchConfirmationPort,
): Promise<LaunchConfirmationAttempt> {
  const read = await readAlert(port);
  if ('outcome' in read) return read;
  if (!read.alert) return { outcome: 'absent' };
  if (!isLaunchConfirmation(read.alert)) {
    emitDiagnostic({
      level: 'warn',
      phase: 'ios_launch_confirmation_unanswered',
      data: {
        reason: 'alert-unrecognized',
        title: read.alert['message'],
        buttons: read.alert['items'],
      },
    });
    return { outcome: 'unanswered', reason: 'alert-unrecognized' };
  }
  const owner = await resolveUrlOwner(port);
  if ('outcome' in owner) return owner;
  if (owner.owner === undefined) {
    reportUnanswered('url-owner-unresolved', {});
    return { outcome: 'unanswered', reason: 'url-owner-unresolved' };
  }
  if (owner.owner !== port.appBundleId) {
    throw new AppError('COMMAND_FAILED', `The launch URL asks to open ${owner.owner} instead.`, {
      reason: LAUNCH_CONFIRMATION_FOREIGN_APP_REASON,
      foreignAppBundleId: owner.owner,
      sessionAppBundleId: port.appBundleId,
      hint: `iOS is asking whether to open ${owner.owner}. Answer it with alert accept or alert dismiss, and pass a launch URL whose scheme belongs to the session app.`,
    });
  }
  return await port.acceptAlert().then(accepted, unreadable('alert-accept'));
}

async function readAlert(
  port: LaunchConfirmationPort,
): Promise<Readonly<{ alert: Record<string, unknown> | undefined }> | LaunchConfirmationAttempt> {
  return await port.readAlert().then((alert) => ({ alert }), unreadable('alert-read'));
}

async function resolveUrlOwner(
  port: LaunchConfirmationPort,
): Promise<Readonly<{ owner: string | undefined }> | LaunchConfirmationAttempt> {
  return await port.resolveUrlOwner().then((owner) => ({ owner }), unreadable('url-owner'));
}

function accepted(): LaunchConfirmationAttempt {
  return { outcome: 'accepted' };
}

function isLaunchConfirmation(alert: Record<string, unknown>): boolean {
  const title = alert['message'];
  return typeof title === 'string' && LAUNCH_CONFIRMATION_TITLE.test(title);
}

/** A failed step leaves the open unanswered; the failure is reported, not thrown. */
function unreadable(step: LaunchConfirmationStep): (error: unknown) => LaunchConfirmationAttempt {
  return (error) => {
    reportUnanswered('step-failed', {
      step,
      code: error instanceof AppError ? error.code : undefined,
    });
    return { outcome: 'unreadable', step };
  };
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
 * accept. A runner that cannot be resolved is reported as an unreadable attempt.
 */
export async function answerSimulatorLaunchConfirmation(
  device: DeviceInfo,
  confirmation: LaunchConfirmationTarget,
  interactor: Promise<Interactor>,
  signal: AbortSignal,
): Promise<LaunchConfirmationAttempt> {
  const settled: Readonly<{ interactor: Interactor }> | LaunchConfirmationAttempt =
    await interactor.then((resolved) => ({ interactor: resolved }), unreadable('runner'));
  if ('outcome' in settled) return settled;
  return await answerLaunchConfirmation(
    createLaunchConfirmationPort(device, confirmation, settled.interactor, signal),
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
