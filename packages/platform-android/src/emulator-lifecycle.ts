import { deviceShellArgv } from '@agent-device/kernel/device-shell';
import { AppError, asAppError, createRequestCanceledError } from '@agent-device/kernel/errors';
import { isCommandTimeoutError, type ExecResult } from '@agent-device/host-kit/command';
import { Deadline, retryWithPolicy } from '@agent-device/host-kit/retry';

import { androidAdbInvocation, androidAdbSerialTarget } from './adb-transport.ts';
import { runAndroidHostAdb } from './adb-executor.ts';
import {
  BOOT_FAILURE_REASONS,
  bootFailureHint,
  type BootFailureReason,
} from '@agent-device/provision-kit/boot-diagnostics';

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
        if (signal?.aborted) throw androidBootCancellation(signal);
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
    if (signal?.aborted) throw androidBootCancellation(signal);
    throwAndroidBootFailure({ error, serial, timeoutMs, deadline, lastBootResult, timedOut });
  }
}

/** Keeps the cancellation owner's typed error, such as its deadline details. */
function androidBootCancellation(signal: AbortSignal): AppError {
  return signal.reason instanceof AppError
    ? signal.reason
    : createRequestCanceledError(undefined, signal.reason);
}

/**
 * Whether a boot-poll observation is transient and may be retried inside the aggregate budget.
 * Consumes only typed `details` evidence; wording never decides. Shared by every Android boot
 * poller so the verdicts stay identical across owners.
 */
export function isTransientAndroidBootFailure(error: unknown): boolean {
  const details = asAppError(error).details;
  return (
    details?.bootObservation === 'not_ready' ||
    (details?.retriable === true &&
      (details.adbFailure === 'device_offline' || details.adbHostRefusal !== true))
  );
}

/** The typed boot failure reason for a terminal boot-poll observation; wording never decides. */
export function androidBootFailureReason(error: unknown): BootFailureReason {
  const appError = asAppError(error);
  if (
    appError.code === 'TOOL_MISSING' ||
    appError.details?.adbHostRefusal === true ||
    appError.details?.adbFailure === 'device_unauthorized'
  ) {
    return BOOT_FAILURE_REASONS.adbTransportUnavailable.reason;
  }
  if (appError.details?.adbFailure === 'timeout' || isCommandTimeoutError(appError)) {
    return BOOT_FAILURE_REASONS.androidBootTimeout.reason;
  }
  return BOOT_FAILURE_REASONS.bootCommandFailed.reason;
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
  // A transient observation that ended the retry loop means the retries used the budget.
  const budgetSpent =
    params.timedOut || params.deadline.isExpired() || isTransientAndroidBootFailure(params.error);
  throw buildAndroidBootError(
    appError,
    reason,
    budgetSpent,
    buildAndroidBootFailureDetails(params, reason),
  );
}

function normalizedAndroidBootFailureReason(
  params: Parameters<typeof throwAndroidBootFailure>[0],
  appError: AppError,
): BootFailureReason {
  if (isTransientAndroidBootFailure(params.error) || params.timedOut)
    return BOOT_FAILURE_REASONS.androidBootTimeout.reason;
  return androidBootFailureReason(appError);
}

function buildAndroidBootFailureDetails(
  params: Parameters<typeof throwAndroidBootFailure>[0],
  reason: BootFailureReason,
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

/** The details every Android boot poller reports for a terminal boot failure. */
type AndroidBootFailureDetails = Readonly<
  { serial: string; elapsedMs: number; hint: string; reason: BootFailureReason } & Record<
    string,
    unknown
  >
>;

/**
 * Shapes one terminal boot failure. Shared by every Android boot poller so one typed observation
 * gets the same code, message and cause at each. `budgetSpent` is true only when the caller's boot
 * deadline has expired, or its retries ended on a still-booting observation: only then does the
 * message say that the device did not boot in time. A failure inside the budget keeps the message
 * of the layer that failed. The code is the failure's own, so a caller that can receive a
 * non-AppError normalizes it before the call.
 */
export function buildAndroidBootError(
  appError: AppError,
  reason: BootFailureReason,
  budgetSpent: boolean,
  details: AndroidBootFailureDetails,
): AppError {
  // A missing tool is not a slow boot: it keeps its code and message even on a spent budget.
  if (appError.code === 'TOOL_MISSING') {
    return new AppError('TOOL_MISSING', appError.message, details, appError.cause);
  }
  // A terminal transport failure (an unauthorized device, say) is not a slow boot either.
  if (reason === BOOT_FAILURE_REASONS.adbTransportUnavailable.reason) {
    return new AppError('COMMAND_FAILED', appError.message, details, appError.cause);
  }
  if (budgetSpent) {
    return new AppError(
      'COMMAND_FAILED',
      'Android device did not finish booting in time',
      details,
      appError.cause,
    );
  }
  return new AppError(appError.code, appError.message, details, appError.cause);
}
