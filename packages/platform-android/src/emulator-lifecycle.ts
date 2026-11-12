import { deviceShellArgv } from '@agent-device/kernel/device-shell';
import { AppError, asAppError, createRequestCanceledError } from '@agent-device/kernel/errors';
import type { ExecResult } from '@agent-device/host-kit/command';
import { Deadline, retryWithPolicy } from '@agent-device/host-kit/retry';

import { androidAdbInvocation, androidAdbSerialTarget } from './adb-transport.ts';
import { runAndroidHostAdb } from './adb-executor.ts';
import { bootFailureHint, classifyBootFailure } from '@agent-device/provision-kit/boot-diagnostics';

const ANDROID_BOOT_POLL_MS = 1_000;
const ANDROID_BOOT_PROP_TIMEOUT_MS = 10_000;

async function readAndroidBootProp(
  serial: string,
  timeoutMs = ANDROID_BOOT_PROP_TIMEOUT_MS,
  signal?: AbortSignal,
): Promise<ExecResult> {
  return await runAndroidHostAdb(
    androidAdbInvocation(
      androidAdbSerialTarget(serial),
      deviceShellArgv('adb', 'shell', ['getprop', 'sys.boot_completed']),
    ),
    { signal, timeoutMs },
  );
}

export async function waitForAndroidBoot(
  serial: string,
  timeoutMs = 60_000,
  signal?: AbortSignal,
): Promise<void> {
  const deadline = Deadline.fromTimeoutMs(timeoutMs);
  const pollMs = Math.min(ANDROID_BOOT_POLL_MS, Math.max(50, Math.floor(timeoutMs / 20)));
  const maxAttempts = Math.max(1, Math.ceil(timeoutMs / pollMs));
  let lastBootResult: ExecResult | undefined;
  let timedOut = false;
  try {
    await retryWithPolicy(
      async ({ deadline: attemptDeadline }) => {
        if (attemptDeadline?.isExpired()) {
          timedOut = true;
          throw new AppError('COMMAND_FAILED', 'Android boot deadline exceeded', {
            serial,
            timeoutMs,
            elapsedMs: deadline.elapsedMs(),
            message: 'timeout',
          });
        }
        const remainingMs = Math.max(1_000, attemptDeadline?.remainingMs() ?? timeoutMs);
        const result = await readAndroidBootProp(
          serial,
          Math.min(remainingMs, ANDROID_BOOT_PROP_TIMEOUT_MS),
          signal,
        );
        if (signal?.aborted) throw createRequestCanceledError();
        lastBootResult = result;
        if (result.stdout.trim() === '1') return;
        // exec-guard-allow: getprop exits 0 while the device is still booting;
        // the throw is a retry-loop poll miss, not a process-exit wrap.
        throw new AppError('COMMAND_FAILED', 'Android device is still booting', {
          serial,
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.exitCode,
          bootObservation: 'not_ready',
        });
      },
      {
        maxAttempts,
        baseDelayMs: pollMs,
        maxDelayMs: pollMs,
        jitter: 0,
        shouldRetry: isTransientAndroidBootFailure,
      },
      {
        deadline,
        phase: 'boot',
        signal,
        classifyReason: (error) => androidBootFailureReason(error),
      },
    );
  } catch (error) {
    if (signal?.aborted) throw createRequestCanceledError();
    throwAndroidBootFailure({ error, serial, timeoutMs, deadline, lastBootResult, timedOut });
  }
}

function isTransientAndroidBootFailure(error: unknown): boolean {
  const details = asAppError(error).details;
  return (
    details?.bootObservation === 'not_ready' ||
    (details?.adbFailure === 'device_offline' && details.adbHostRefusal === true)
  );
}

function androidBootFailureReason(error: unknown): ReturnType<typeof classifyBootFailure> {
  const appError = asAppError(error);
  if (appError.code === 'TOOL_MISSING' || appError.details?.adbHostRefusal === true) {
    return 'ADB_TRANSPORT_UNAVAILABLE';
  }
  if (appError.details?.adbFailure === 'timeout') return 'ANDROID_BOOT_TIMEOUT';
  return 'BOOT_COMMAND_FAILED';
}

function throwAndroidBootFailure(params: {
  error: unknown;
  serial: string;
  timeoutMs: number;
  deadline: Deadline;
  lastBootResult?: ExecResult;
  timedOut: boolean;
}): never {
  const appError = asAppError(params.error);
  const reason = normalizedAndroidBootFailureReason(params, appError);
  throw buildAndroidBootError(
    appError,
    reason,
    params.timedOut,
    buildAndroidBootFailureDetails(params, reason),
  );
}

function normalizedAndroidBootFailureReason(
  params: Parameters<typeof throwAndroidBootFailure>[0],
  appError: AppError,
): ReturnType<typeof classifyBootFailure> {
  if (isTransientAndroidBootFailure(params.error) || params.timedOut) return 'ANDROID_BOOT_TIMEOUT';
  return androidBootFailureReason(appError);
}

function buildAndroidBootFailureDetails(
  params: Parameters<typeof throwAndroidBootFailure>[0],
  reason: ReturnType<typeof classifyBootFailure>,
) {
  return {
    serial: params.serial,
    timeoutMs: params.timeoutMs,
    elapsedMs: params.deadline.elapsedMs(),
    hint: bootFailureHint(reason),
    stdout: params.lastBootResult?.stdout,
    stderr: params.lastBootResult?.stderr,
    exitCode: params.lastBootResult?.exitCode,
    ...(asAppError(params.error).details ?? {}),
    reason,
  };
}

function buildAndroidBootError(
  appError: AppError,
  reason: ReturnType<typeof classifyBootFailure>,
  timedOut: boolean,
  details: ReturnType<typeof buildAndroidBootFailureDetails>,
): AppError {
  if (timedOut || reason === 'ANDROID_BOOT_TIMEOUT') {
    return new AppError('COMMAND_FAILED', 'Android device did not finish booting in time', details);
  }
  if (appError.code === 'TOOL_MISSING') {
    return new AppError('TOOL_MISSING', appError.message, details);
  }
  if (reason === 'ADB_TRANSPORT_UNAVAILABLE') {
    return new AppError('COMMAND_FAILED', appError.message, details);
  }
  return new AppError(appError.code, appError.message, details, appError.cause);
}
