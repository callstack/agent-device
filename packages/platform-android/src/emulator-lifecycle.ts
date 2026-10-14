import { deviceShellArgv } from '@agent-device/kernel/device-shell';
import { AppError, asAppError } from '@agent-device/kernel/errors';
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
    { allowFailure: true, signal, timeoutMs },
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
        lastBootResult = result;
        if (result.stdout.trim() === '1') return;
        // exec-guard-allow: getprop exits 0 while the device is still booting;
        // the throw is a retry-loop poll miss, not a process-exit wrap.
        throw new AppError('COMMAND_FAILED', 'Android device is still booting', {
          serial,
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.exitCode,
        });
      },
      {
        maxAttempts,
        baseDelayMs: pollMs,
        maxDelayMs: pollMs,
        jitter: 0,
        shouldRetry: (error) => {
          const reason = classifyBootFailure({
            error,
            stdout: lastBootResult?.stdout,
            stderr: lastBootResult?.stderr,
            context: { platform: 'android', phase: 'boot' },
          });
          return reason !== 'ADB_TRANSPORT_UNAVAILABLE' && reason !== 'ANDROID_BOOT_TIMEOUT';
        },
      },
      {
        deadline,
        phase: 'boot',
        signal,
        classifyReason: (error) =>
          classifyBootFailure({
            error,
            stdout: lastBootResult?.stdout,
            stderr: lastBootResult?.stderr,
            context: { platform: 'android', phase: 'boot' },
          }),
      },
    );
  } catch (error) {
    throwAndroidBootFailure({ error, serial, timeoutMs, deadline, lastBootResult, timedOut });
  }
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
  const classified = classifyBootFailure({
    error: params.error,
    stdout: params.lastBootResult?.stdout,
    stderr: params.lastBootResult?.stderr,
    context: { platform: 'android', phase: 'boot' },
  });
  return classified === 'BOOT_COMMAND_FAILED' &&
    appError.message === 'Android device is still booting'
    ? 'ANDROID_BOOT_TIMEOUT'
    : classified;
}

function buildAndroidBootFailureDetails(
  params: Parameters<typeof throwAndroidBootFailure>[0],
  reason: ReturnType<typeof classifyBootFailure>,
) {
  return {
    serial: params.serial,
    timeoutMs: params.timeoutMs,
    elapsedMs: params.deadline.elapsedMs(),
    reason,
    hint: bootFailureHint(reason),
    stdout: params.lastBootResult?.stdout,
    stderr: params.lastBootResult?.stderr,
    exitCode: params.lastBootResult?.exitCode,
    ...(asAppError(params.error).details ?? {}),
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
