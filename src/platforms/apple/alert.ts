import {
  ALERT_ACTION_RETRY_MS,
  ALERT_POLL_INTERVAL_MS,
  DEFAULT_ALERT_TIMEOUT_MS,
} from '@agent-device/contracts/alert-contract';
import type {
  AlertInteractorOptions,
  RunnerCallOptions,
} from '@agent-device/contracts/interaction';
import { isIosFamily, isMacOs, type DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import { sleep } from '../../utils/timeouts.ts';
import { runAppleRunnerCommand } from './core/runner/runner-client.ts';
import { runMacOsAlertAction } from './os/macos/helper.ts';

/**
 * Apple's four alert legs. R59 moved them here from the daemon: how long to look for a transient
 * alert, how many times to re-ask a runner that answers "alert not found", and which of the two
 * Apple backends answers at all are family mechanics, not request policy. What the caller supplies
 * is the window it allows and the session's target; everything else is this family's.
 */
type NativeAlertAction = 'get' | 'accept' | 'dismiss';

const ALERT_FALLBACK_HINT =
  'If the permission sheet is visible in snapshot or screenshot but alert reports no alert, take a scoped snapshot around the visible button label and use press @ref.';

/**
 * The one backend split: the macOS host answers through its helper, every other Apple leaf
 * through the XCTest runner. The macOS target deliberately carries no bundle on a frontmost-app
 * session — that surface means "whatever is frontmost", and naming a bundle would contradict it.
 */
function runAppleAlert(
  device: DeviceInfo,
  runnerOptions: RunnerCallOptions,
  options: AlertInteractorOptions | undefined,
): (action: NativeAlertAction, timeoutMs: number) => Promise<Record<string, unknown>> {
  if (isMacOs(device)) {
    const target =
      options?.surface === 'frontmost-app'
        ? { surface: options.surface }
        : { bundleId: options?.appBundleId, surface: options?.surface };
    return async (action) => (await runMacOsAlertAction(action, target)) as Record<string, unknown>;
  }
  return async (action, timeoutMs) =>
    (await runAppleRunnerCommand(
      device,
      { command: 'alert', action, appBundleId: options?.appBundleId, timeoutMs },
      runnerOptions,
    )) as Record<string, unknown>;
}

export async function readAppleAlert(
  device: DeviceInfo,
  runnerOptions: RunnerCallOptions,
  options?: AlertInteractorOptions,
): Promise<Record<string, unknown>> {
  return await runAppleAlert(device, runnerOptions, options)('get', DEFAULT_ALERT_TIMEOUT_MS);
}

/**
 * Poll `get` until one answers or the caller's window runs out. The first attempt gets the whole
 * window and later ones only what is left, so a runner that blocks cannot outlive the budget.
 */
export async function awaitAppleAlert(
  device: DeviceInfo,
  runnerOptions: RunnerCallOptions,
  options?: AlertInteractorOptions,
): Promise<Record<string, unknown>> {
  const runAlert = runAppleAlert(device, runnerOptions, options);
  const timeout = options?.timeoutMs ?? DEFAULT_ALERT_TIMEOUT_MS;
  const start = Date.now();
  let firstAttempt = true;
  while (Date.now() - start < timeout) {
    try {
      const budgetMs = firstAttempt ? timeout : remainingBudgetMs(start, timeout);
      firstAttempt = false;
      return await runAlert('get', budgetMs);
    } catch {
      // keep waiting
    }
    await sleep(ALERT_POLL_INTERVAL_MS);
  }
  throw new AppError('COMMAND_FAILED', 'alert wait timed out');
}

/**
 * Accept and dismiss retry only while the backend keeps saying the alert is not there yet — a
 * sheet that is still animating in. Any other failure is reported on its first occurrence, and
 * an exhausted retry window carries the scoped-snapshot fallback the agent needs next.
 */
export async function actOnAppleAlert(
  device: DeviceInfo,
  runnerOptions: RunnerCallOptions,
  action: 'accept' | 'dismiss',
  options?: AlertInteractorOptions,
): Promise<Record<string, unknown>> {
  const runAlert = runAppleAlert(device, runnerOptions, options);
  const runnerTimeoutMs = isIosFamily(device) ? DEFAULT_ALERT_TIMEOUT_MS : ALERT_ACTION_RETRY_MS;
  const start = Date.now();
  let lastError: unknown;
  let firstAttempt = true;
  while (Date.now() - start < ALERT_ACTION_RETRY_MS) {
    try {
      const budgetMs = firstAttempt
        ? runnerTimeoutMs
        : remainingBudgetMs(start, ALERT_ACTION_RETRY_MS);
      firstAttempt = false;
      return await runAlert(action, budgetMs);
    } catch (err) {
      lastError = err;
      if (!isAlertNotFoundError(err)) break;
    }
    await sleep(ALERT_POLL_INTERVAL_MS);
  }
  throw withAlertFallbackHint(lastError);
}

function remainingBudgetMs(start: number, timeoutMs: number): number {
  return Math.max(1, timeoutMs - (Date.now() - start));
}

function withAlertFallbackHint(error: unknown): unknown {
  if (!(error instanceof AppError) || !isAlertNotFoundError(error)) return error;
  return new AppError(error.code, error.message, {
    ...(error.details ?? {}),
    hint: ALERT_FALLBACK_HINT,
  });
}

function isAlertNotFoundError(error: unknown): boolean {
  const message = String((error as { message?: unknown })?.message ?? '').toLowerCase();
  return message.includes('alert not found') || message.includes('no alert');
}
