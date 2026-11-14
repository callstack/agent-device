import {
  ALERT_ACTION_RETRY_MS,
  ALERT_MIN_READ_BUDGET_MS,
  ALERT_NOT_FOUND_REASON,
  ALERT_WAIT_TIMEOUT_REASON,
  ALERT_NOT_FOUND_RUNNER_CODE,
  ALERT_POLL_INTERVAL_MS,
  ALERT_RUNNER_MAX_BUDGET_MS,
  ALERT_UNRESOLVED_RUNNER_CODE,
  DEFAULT_ALERT_TIMEOUT_MS,
} from '@agent-device/contracts/alert-contract';
import type {
  AlertInteractorOptions,
  RunnerCallOptions,
} from '@agent-device/contracts/interactor-types';
import { isIosFamily, isMacOs, type DeviceInfo } from '@agent-device/kernel/device';
import type { EnvMap } from '@agent-device/kernel/source-value';
import { AppError } from '@agent-device/kernel/errors';
import { sleep } from '@agent-device/host-kit/retry';
import { runAppleRunnerCommand } from './core/runner-client.ts';
import { runMacOsAlertAction } from './os/macos/helper.ts';

/**
 * Apple's four alert legs. R59 moved them here from the daemon: how long to look for a transient
 * alert, how many times to re-ask a backend that reports the alert is not there yet, and which of
 * the two Apple backends answers at all are family mechanics, not request policy. What the caller
 * supplies is the window it allows and the session's target; everything else is this family's.
 *
 * Absence is retriable, and both backends state it as typed evidence — the XCTest runner as
 * `ALERT_NOT_FOUND`, the macOS helper as `reason: 'alert-not-found'`. The runner's
 * `ALERT_UNRESOLVED` (a system prompt it saw but could not read) is retried in the same windows,
 * since its host may become readable, but it is never absence: a window that ends on it reports
 * it. Nothing here reads an error message: a transport, runner or helper failure that happened to
 * mention an alert would otherwise be retried until the window expired and then reported as a
 * timeout, hiding the cause.
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
  env: Readonly<EnvMap>,
): (action: NativeAlertAction, timeoutMs: number) => Promise<Record<string, unknown>> {
  if (isMacOs(device)) {
    const target =
      options?.surface === 'frontmost-app'
        ? { surface: options.surface }
        : { bundleId: options?.appBundleId, surface: options?.surface };
    return async (action) =>
      (await runMacOsAlertAction(action, { ...target, env })) as Record<string, unknown>;
  }
  return async (action, timeoutMs) =>
    (await runAppleRunnerCommand(
      device,
      {
        command: 'alert',
        action,
        appBundleId: options?.appBundleId,
        timeoutMs: Math.min(timeoutMs, ALERT_RUNNER_MAX_BUDGET_MS),
      },
      runnerOptions,
    )) as Record<string, unknown>;
}

/** The alert `read` settles with, or `undefined` when the backend reports a typed absence. */
export async function alertIfPresent<T>(read: Promise<T>): Promise<T | undefined> {
  try {
    return await read;
  } catch (error) {
    if (isAlertNotFoundError(error)) return undefined;
    throw error;
  }
}

/**
 * One read spends the caller's window as the runner's budget, within
 * `ALERT_MIN_READ_BUDGET_MS` and `ALERT_RUNNER_MAX_BUDGET_MS`, and `DEFAULT_ALERT_TIMEOUT_MS` when
 * the caller gave none. A read the runner's main-thread watchdog cuts off is not absence: its
 * `MAIN_THREAD_TIMEOUT` is reported as itself (`reason: runner_main_thread_timeout`, `dispatched:
 * unknown`). The next read runs once the abandoned work drains, or reports `RUNNER_BUSY` when the
 * bounded resends end first.
 */
export async function readAppleAlert(
  device: DeviceInfo,
  runnerOptions: RunnerCallOptions,
  options: AlertInteractorOptions | undefined,
  env: Readonly<EnvMap>,
): Promise<Record<string, unknown>> {
  const requestedMs = options?.timeoutMs;
  const budgetMs =
    requestedMs === undefined || !Number.isFinite(requestedMs)
      ? DEFAULT_ALERT_TIMEOUT_MS
      : Math.max(requestedMs, ALERT_MIN_READ_BUDGET_MS);
  return await runAppleAlert(device, runnerOptions, options, env)('get', budgetMs);
}

/**
 * Poll `get` until one answers or the caller's window runs out. The first attempt gets the window,
 * capped at `ALERT_RUNNER_MAX_BUDGET_MS`, and later ones only what is left (same cap), so a runner
 * that blocks cannot outlive the budget.
 * After a completed observation, another read needs more than one polling interval of budget.
 * A dispatched read still owns its result, including a watchdog timeout.
 */
export async function awaitAppleAlert(
  device: DeviceInfo,
  runnerOptions: RunnerCallOptions,
  options: AlertInteractorOptions | undefined,
  env: Readonly<EnvMap>,
): Promise<Record<string, unknown>> {
  const runAlert = runAppleAlert(device, runnerOptions, options, env);
  const timeout = options?.timeoutMs ?? DEFAULT_ALERT_TIMEOUT_MS;
  const start = Date.now();
  let lastRetriable: AppError | undefined;
  while (Date.now() - start < timeout) {
    const remainingMs = remainingBudgetMs(start, timeout);
    if (lastRetriable && remainingMs <= ALERT_POLL_INTERVAL_MS) {
      await sleep(remainingMs);
      break;
    }
    try {
      const budgetMs = lastRetriable ? remainingMs : timeout;
      return await runAlert('get', budgetMs);
    } catch (error) {
      // Only a typed absence or an unreadable prompt is worth waiting out. Anything else — a dead
      // runner, an unreachable helper, a canceled request — is reported as itself rather than
      // spent as poll budget and relabeled `alert wait timed out`.
      if (!isAlertRetriableError(error)) throw error;
      lastRetriable = error;
    }
    const remainingMsAfterRead = timeout - (Date.now() - start);
    if (remainingMsAfterRead > 0) {
      await sleep(Math.min(ALERT_POLL_INTERVAL_MS, remainingMsAfterRead));
    }
  }
  if (isAlertUnresolvedError(lastRetriable)) throw lastRetriable;
  throw new AppError('COMMAND_FAILED', 'alert wait timed out', {
    ...lastRetriable?.details,
    reason: ALERT_WAIT_TIMEOUT_REASON,
  });
}

/**
 * Accept and dismiss retry only while the backend keeps reporting a typed absence — a sheet that
 * is still animating in — or an unreadable prompt. Any other failure is reported on its first
 * occurrence. A window exhausted on absence carries the scoped-snapshot fallback the agent needs
 * next; one exhausted on an unreadable prompt keeps the runner's own hint.
 *
 * Retries start within `ALERT_ACTION_RETRY_MS`. Each XCTest runner retry gets at least
 * `ALERT_MIN_READ_BUDGET_MS` to avoid cutting alert acquisition short, so an in-flight retry
 * can finish after the retry window. The macOS helper ignores the read budget.
 */
export async function actOnAppleAlert(
  device: DeviceInfo,
  runnerOptions: RunnerCallOptions,
  action: 'accept' | 'dismiss',
  options: AlertInteractorOptions | undefined,
  env: Readonly<EnvMap>,
): Promise<Record<string, unknown>> {
  const runAlert = runAppleAlert(device, runnerOptions, options, env);
  const runnerTimeoutMs = isIosFamily(device) ? DEFAULT_ALERT_TIMEOUT_MS : ALERT_ACTION_RETRY_MS;
  const start = Date.now();
  let lastError: unknown;
  let firstAttempt = true;
  while (Date.now() - start < ALERT_ACTION_RETRY_MS) {
    try {
      const budgetMs = firstAttempt
        ? runnerTimeoutMs
        : Math.max(remainingBudgetMs(start, ALERT_ACTION_RETRY_MS), ALERT_MIN_READ_BUDGET_MS);
      firstAttempt = false;
      return await runAlert(action, budgetMs);
    } catch (error) {
      lastError = error;
      if (!isAlertRetriableError(error)) break;
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

/**
 * Absence, as the backend itself classified it. The XCTest runner's `ALERT_NOT_FOUND` arrives as
 * `details.runnerErrorCode` (it stays `COMMAND_FAILED` on the wire, like `RUNNER_BUSY`); the macOS
 * helper's arrives as `details.reason`, forwarded verbatim from its JSON error envelope.
 */
function isAlertNotFoundError(error: unknown): error is AppError {
  if (!(error instanceof AppError)) return false;
  const details = error.details ?? {};
  return (
    details['runnerErrorCode'] === ALERT_NOT_FOUND_RUNNER_CODE ||
    details['reason'] === ALERT_NOT_FOUND_REASON
  );
}

/** A prompt the XCTest runner saw but could not read; it travels as its own wire code. */
function isAlertUnresolvedError(error: unknown): boolean {
  return (
    error instanceof AppError && error.details?.['runnerErrorCode'] === ALERT_UNRESOLVED_RUNNER_CODE
  );
}

function isAlertRetriableError(error: unknown): error is AppError {
  return (
    error instanceof AppError && (isAlertNotFoundError(error) || isAlertUnresolvedError(error))
  );
}
