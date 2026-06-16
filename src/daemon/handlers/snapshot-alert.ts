import { isCommandSupportedOnDevice } from '../../core/capabilities.ts';
import type { AlertAction } from '../../alert-contract.ts';
import { sleep } from '../../utils/timeouts.ts';
import { runIosRunnerCommand } from '../../platforms/ios/runner-client.ts';
import { runMacOsAlertAction } from '../../platforms/ios/macos-helper.ts';
import { handleAndroidAlert } from '../../platforms/android/alert.ts';
import { AppError } from '../../utils/errors.ts';
import type { DaemonRequest, DaemonResponse, SessionState } from '../types.ts';
import { SessionStore } from '../session-store.ts';
import { recordIfSession } from './snapshot-session.ts';
import {
  ALERT_ACTION_RETRY_MS,
  DEFAULT_TIMEOUT_MS,
  parseTimeout,
  POLL_INTERVAL_MS,
} from './parse-utils.ts';
import { errorResponse } from './response.ts';

type HandleAlertCommandParams = {
  req: DaemonRequest;
  logPath: string;
  sessionStore: SessionStore;
  session: SessionState | undefined;
  device: SessionState['device'];
};

type NativeAlertAction = Exclude<AlertAction, 'wait'>;
type NativeAlertRunner = (action: NativeAlertAction) => Promise<unknown>;

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
  if (!isCommandSupportedOnDevice('alert', device)) {
    return errorResponse('UNSUPPORTED_OPERATION', 'alert is not supported on this device');
  }
  if (device.platform === 'android') {
    const timeoutMs = parseTimeout(req.positionals?.[1]) ?? DEFAULT_TIMEOUT_MS;
    return recordAlertResponse(
      params,
      await handleAndroidAlert(device, action, {
        timeoutMs,
      }),
    );
  }
  if (device.platform === 'macos') {
    const runAlert: NativeAlertRunner = async (alertAction) =>
      await runMacOsAlertAction(alertAction, macOsAlertTarget);
    return await handleNativeAlertCommand(params, action, runAlert);
  }

  const runnerOptions = {
    verbose: req.flags?.verbose,
    logPath,
    traceLogPath: session?.trace?.outPath,
    requestId: req.meta?.requestId,
    iosXctestrunFile: req.flags?.iosXctestrunFile,
    iosXctestDerivedDataPath: req.flags?.iosXctestDerivedDataPath,
    iosXctestEnvDir: req.flags?.iosXctestEnvDir,
  };
  const runAlert: NativeAlertRunner = async (alertAction) =>
    await runIosRunnerCommand(
      device,
      { command: 'alert', action: alertAction, appBundleId: session?.appBundleId },
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

  return recordAlertResponse(params, await runAlert('get'));
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
  while (Date.now() - start < timeout) {
    try {
      return recordAlertResponse(params, await runAlert('get'));
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
  const start = Date.now();
  let lastError: unknown;
  while (Date.now() - start < ALERT_ACTION_RETRY_MS) {
    try {
      return recordAlertResponse(params, await runAlert(action));
    } catch (err) {
      lastError = err;
      const msg = String((err as { message?: unknown })?.message ?? '').toLowerCase();
      if (!msg.includes('alert not found') && !msg.includes('no alert')) break;
    }
    await sleep(POLL_INTERVAL_MS);
  }
  throw withAlertFallbackHint(lastError);
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
