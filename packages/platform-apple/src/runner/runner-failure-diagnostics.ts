import fs from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { AppError, type AppErrorCode } from '@agent-device/kernel/errors';

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

/**
 * Where `runner.log` had reached before a command was sent (#2683). The runner writes one log per
 * device and it is never truncated between commands, so everything an earlier command produced is
 * still there when a later one fails. Reading the tail of that file without this marker blames an
 * older command's crash on the command that merely happened to fail next.
 */
export type RunnerLogOffset = Readonly<{ logPath: string; byteOffset: number }>;

/**
 * Marks the end of `runner.log` as it stands right now, to be handed to
 * {@link enrichRunnerFailureFromLog} when the command this precedes fails.
 *
 * A log that does not exist yet is reported as `byteOffset: 0` rather than skipped: every byte it
 * gets from here on belongs to this command, which is exactly the claim worth keeping.
 */
export async function captureRunnerLogOffset(
  logPath: string | undefined,
): Promise<RunnerLogOffset | undefined> {
  if (!logPath) return undefined;
  try {
    return { logPath, byteOffset: (await fs.stat(logPath)).size };
  } catch {
    return { logPath, byteOffset: 0 };
  }
}

export async function enrichRunnerFailureFromLog(params: {
  error: AppError;
  logPath?: string;
  /** Bytes of `runner.log` that were already there when the failing command was sent. */
  logSince?: RunnerLogOffset;
}): Promise<AppError> {
  const diagnostic =
    (await resolveRunnerFailureDiagnostic(
      params.logSince ?? (params.logPath ? { logPath: params.logPath, byteOffset: 0 } : undefined),
    )) ?? classifyRunnerFailureError(params.error);
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
  logSince: RunnerLogOffset | undefined,
): Promise<RunnerFailureDiagnostic | undefined> {
  if (!logSince) return undefined;
  const tail = await readFileSince(logSince, RUNNER_LOG_TAIL_BYTES);
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

async function readFileSince(
  logSince: RunnerLogOffset,
  maxBytes: number,
): Promise<string | undefined> {
  let handle: FileHandle | undefined;
  try {
    const stat = await fs.stat(logSince.logPath);
    // Never reads before the marker, and never reads more than the tail budget of what came after
    // it. A log that is shorter than the marker has been replaced underneath us, which is not
    // evidence about this command.
    const start = Math.max(logSince.byteOffset, stat.size - maxBytes);
    const length = stat.size - start;
    if (length <= 0) return undefined;

    handle = await fs.open(logSince.logPath, 'r');
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, start);
    return buffer.toString('utf8');
  } catch {
    return undefined;
  } finally {
    await handle?.close().catch(() => {});
  }
}
