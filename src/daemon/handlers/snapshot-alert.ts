import { isIosFamily, isMacOs } from '../../kernel/device.ts';
import {
  ALERT_ACTION_RETRY_MS,
  ALERT_POLL_INTERVAL_MS as POLL_INTERVAL_MS,
  DEFAULT_ALERT_TIMEOUT_MS as DEFAULT_TIMEOUT_MS,
  type AlertAction,
} from '../../alert-contract.ts';
import { sleep } from '../../utils/timeouts.ts';
import { runAppleRunnerCommand } from '../../platforms/apple/core/runner/runner-client.ts';
import { runMacOsAlertAction } from '../../platforms/apple/os/macos/helper.ts';
import { handleAndroidAlert } from '../../platforms/android/alert.ts';
import { AppError } from '../../kernel/errors.ts';
import type { DaemonRequest, DaemonResponse, SessionState } from '../types.ts';
import { SessionStore } from '../session-store.ts';
import { buildAppleRunnerRequestOptions } from '../apple-runner-options.ts';
import { recordIfSession } from './snapshot-session.ts';
import { parseTimeout } from '../../utils/parse-timeout.ts';
import { errorResponse, requireCommandSupported } from './response.ts';

type HandleAlertCommandParams = {
  req: DaemonRequest;
  logPath: string;
  sessionStore: SessionStore;
  session: SessionState | undefined;
  device: SessionState['device'];
};

type NativeAlertAction = Exclude<AlertAction, 'wait'>;
type NativeAlertRunner = (action: NativeAlertAction, timeoutMs: number) => Promise<unknown>;

const ALERT_FALLBACK_HINT =
  'If the permission sheet is visible in snapshot or screenshot but alert reports no alert, take a scoped snapshot around the visible button label and use press @ref.';

export async function handleAlertCommand(
  params: HandleAlertCommandParams,
): Promise<DaemonResponse> {
  const { req, logPath, session, device } = params;
  const action = normalizeAlertAction(req.positionals?.[0]);
  const macOsAlertTarget = (() => {
    if (!session) return {};
    if (session.surface === 'frontmost-app') {
      return { surface: 'frontmost-app' as const };
    }
    return {
      bundleId: session.appBundleId,
      surface: session.surface,
    };
  })();
  const unsupported = requireCommandSupported('alert', device);
  if (unsupported) return unsupported;
  if (device.platform === 'android') {
    const timeoutMs = parseTimeout(req.positionals?.[1]) ?? DEFAULT_TIMEOUT_MS;
    return recordAlertResponse(
      params,
      await handleAndroidAlert(device, action, {
        timeoutMs,
      }),
    );
  }
  if (isMacOs(device)) {
    const runAlert: NativeAlertRunner = async (alertAction) =>
      await runMacOsAlertAction(alertAction, macOsAlertTarget);
    return await handleNativeAlertCommand(params, action, runAlert);
  }

  const runnerOptions = buildAppleRunnerRequestOptions({
    req,
    logPath,
    traceLogPath: session?.trace?.outPath,
  });
  const runAlert: NativeAlertRunner = async (alertAction, timeoutMs) =>
    await runAppleRunnerCommand(
      device,
      { command: 'alert', action: alertAction, appBundleId: session?.appBundleId, timeoutMs },
      runnerOptions,
    );
  return await handleNativeAlertCommand(params, action, runAlert);
}

async function handleNativeAlertCommand(
  params: HandleAlertCommandParams,
  action: AlertAction,
  runAlert: NativeAlertRunner,
): Promise<DaemonResponse> {
  if (action === 'wait') {
    return await waitForNativeAlert(params, runAlert);
  }

  const resolvedAction = action === 'accept' || action === 'dismiss' ? action : 'get';
  if (resolvedAction === 'accept' || resolvedAction === 'dismiss') {
    return await handleNativeAlertAction(params, resolvedAction, runAlert);
  }

  return recordAlertResponse(params, await runAlert('get', DEFAULT_TIMEOUT_MS));
}

function normalizeAlertAction(action: string | undefined): AlertAction {
  if (action === 'accept' || action === 'dismiss' || action === 'wait') return action;
  return 'get';
}

async function waitForNativeAlert(
  params: HandleAlertCommandParams,
  runAlert: NativeAlertRunner,
): Promise<DaemonResponse> {
  const timeout = parseTimeout(params.req.positionals?.[1]) ?? DEFAULT_TIMEOUT_MS;
  const start = Date.now();
  let firstAttempt = true;
  while (Date.now() - start < timeout) {
    try {
      const budgetMs = firstAttempt ? timeout : remainingBudgetMs(start, timeout);
      firstAttempt = false;
      return recordAlertResponse(params, await runAlert('get', budgetMs));
    } catch {
      // keep waiting
    }
    await sleep(POLL_INTERVAL_MS);
  }
  return errorResponse('COMMAND_FAILED', 'alert wait timed out');
}

async function handleNativeAlertAction(
  params: HandleAlertCommandParams,
  action: 'accept' | 'dismiss',
  runAlert: NativeAlertRunner,
): Promise<DaemonResponse> {
  const runnerTimeoutMs = isIosFamily(params.device) ? DEFAULT_TIMEOUT_MS : ALERT_ACTION_RETRY_MS;
  const start = Date.now();
  let lastError: unknown;
  let firstAttempt = true;
  while (Date.now() - start < ALERT_ACTION_RETRY_MS) {
    try {
      const budgetMs = firstAttempt
        ? runnerTimeoutMs
        : remainingBudgetMs(start, ALERT_ACTION_RETRY_MS);
      firstAttempt = false;
      return recordAlertResponse(params, await runAlert(action, budgetMs));
    } catch (err) {
      lastError = err;
      const msg = String((err as { message?: unknown })?.message ?? '').toLowerCase();
      if (!msg.includes('alert not found') && !msg.includes('no alert')) break;
    }
    await sleep(POLL_INTERVAL_MS);
  }
  throw withAlertFallbackHint(lastError);
}

function remainingBudgetMs(start: number, timeoutMs: number): number {
  return Math.max(1, timeoutMs - (Date.now() - start));
}

function recordAlertResponse(params: HandleAlertCommandParams, data: unknown): DaemonResponse {
  const responseData = data as Record<string, unknown>;
  recordIfSession(params.sessionStore, params.session, params.req, responseData);
  return { ok: true, data: responseData };
}

function withAlertFallbackHint(error: unknown): unknown {
  if (!(error instanceof AppError)) {
    return error;
  }
  if (!isAlertNotFoundError(error)) {
    return error;
  }
  return new AppError(error.code, error.message, {
    ...(error.details ?? {}),
    hint: ALERT_FALLBACK_HINT,
  });
}

function isAlertNotFoundError(error: unknown): boolean {
  const message = String((error as { message?: unknown })?.message ?? '').toLowerCase();
  return message.includes('alert not found') || message.includes('no alert');
}
