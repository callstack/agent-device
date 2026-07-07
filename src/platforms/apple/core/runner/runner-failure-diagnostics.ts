import fs from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { AppError, type AppErrorCode } from '../../../../kernel/errors.ts';

const RUNNER_LOG_TAIL_BYTES = 64 * 1024;

type RunnerFailureDiagnostic = {
  code?: AppErrorCode;
  reason: string;
  hint: string;
};

const IOS_TARGET_AX_CRASH_HINT =
  'The target iOS app appears to have crashed while XCTest/AXRuntime read accessibility attributes. This is usually a simulator/XCTest/runtime or app accessibility payload issue, not a text-entry failure. Reproduce on the latest stable simulator runtime, reinstall the app, and capture the app crash from Console.app or ~/Library/Logs/DiagnosticReports with the exact command, selector/ref, app build, Xcode, and simulator runtime.';

const IOS_TARGET_APP_CRASH_HINT =
  'The target iOS app appears to have crashed while the runner was executing the command. Reopen or reinstall the app, retry on a fresh/latest stable simulator runtime, and capture the app crash from Console.app or ~/Library/Logs/DiagnosticReports with the exact command, selector/ref, app build, Xcode, and simulator runtime.';

const IOS_RUNNER_MAIN_THREAD_TIMEOUT_HINT =
  'XCTest timed out waiting for main-thread work on the current iOS screen. The app may still be visually responsive, especially on focused React Native overlays or animating screens. Use screenshot as visual truth, use coordinate presses only to prove or leave the state, and retry snapshot -i after the UI settles or after navigating away.';

export async function enrichRunnerFailureFromLog(params: {
  error: AppError;
  logPath?: string;
}): Promise<AppError> {
  const diagnostic =
    (await resolveRunnerFailureDiagnostic(params.logPath)) ??
    classifyRunnerFailureError(params.error);
  if (!diagnostic) return params.error;

  return new AppError(
    diagnostic.code ?? params.error.code,
    params.error.message,
    {
      ...(params.error.details ?? {}),
      hint:
        typeof params.error.details?.hint === 'string'
          ? `${params.error.details.hint} ${diagnostic.hint}`
          : diagnostic.hint,
      runnerFailureReason: diagnostic.reason,
    },
    params.error,
  );
}

async function resolveRunnerFailureDiagnostic(
  logPath: string | undefined,
): Promise<RunnerFailureDiagnostic | undefined> {
  if (!logPath) return undefined;
  const tail = await readFileTail(logPath, RUNNER_LOG_TAIL_BYTES);
  if (!tail) return undefined;
  return classifyRunnerFailureLog(tail);
}

function classifyRunnerFailureLog(logText: string): RunnerFailureDiagnostic | undefined {
  const normalized = logText.toLowerCase();
  if (isAxRuntimeAccessibilityCrash(normalized)) {
    return {
      code: 'IOS_TARGET_APP_CRASH',
      reason: 'target_app_axruntime_coretext_crash',
      hint: IOS_TARGET_AX_CRASH_HINT,
    };
  }
  if (isTargetAppCrash(normalized)) {
    return {
      code: 'IOS_TARGET_APP_CRASH',
      reason: 'target_app_crash',
      hint: IOS_TARGET_APP_CRASH_HINT,
    };
  }
  return undefined;
}

function classifyRunnerFailureError(error: AppError): RunnerFailureDiagnostic | undefined {
  if (!isMainThreadExecutionTimeout(error.message)) return undefined;
  return {
    reason: 'runner_main_thread_execution_timeout',
    hint: IOS_RUNNER_MAIN_THREAD_TIMEOUT_HINT,
  };
}

function isAxRuntimeAccessibilityCrash(normalized: string): boolean {
  return (
    normalized.includes('axruntime') &&
    normalized.includes('coretext') &&
    (normalized.includes('attributesforelement') ||
      normalized.includes('axuielementcopymultipleattributevalues') ||
      normalized.includes('reconstitutedsmuggledctfontfromdictionary') ||
      normalized.includes('reconstitutedsmuggledattributedstringfromdictionary'))
  );
}

function isTargetAppCrash(normalized: string): boolean {
  return (
    normalized.includes('process crashed') ||
    normalized.includes('the application under test') ||
    normalized.includes('terminated unexpectedly') ||
    (normalized.includes('exception type:') && normalized.includes('thread 0 crashed'))
  );
}

function isMainThreadExecutionTimeout(message: string): boolean {
  return message.toLowerCase().includes('main thread execution timed out');
}

async function readFileTail(filePath: string, maxBytes: number): Promise<string | undefined> {
  let handle: FileHandle | undefined;
  try {
    const stat = await fs.stat(filePath);
    const start = Math.max(0, stat.size - maxBytes);
    const length = stat.size - start;
    if (length <= 0) return undefined;

    handle = await fs.open(filePath, 'r');
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, start);
    return buffer.toString('utf8');
  } catch {
    return undefined;
  } finally {
    await handle?.close().catch(() => {});
  }
}
