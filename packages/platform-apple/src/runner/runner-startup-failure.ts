import { AppError } from '@agent-device/kernel/errors';
import { bootFailureHint, classifyBootFailure } from './host.ts';
import type { BootFailureReason } from '@agent-device/provision-kit/boot-diagnostics';
import type { RunnerSession } from './runner-session-types.ts';
import {
  enrichRunnerStartupFailureWithDeviceStates,
  RUNNER_CACHE_RECOVERY_HINT,
  type IosRunnerDeviceStates,
} from './runner-error-classification.ts';

// What an early-exit error quotes of the runner's own log: enough for the boot-failure anchors
// (signing, tunneld, device busy), bounded so a wedged xcodebuild cannot ship a megabyte in details.
const RUNNER_EARLY_EXIT_LOG_TAIL_BYTES = 64 * 1024;

export function resolveRunnerEarlyExitHint(
  message: string,
  stdout: string,
  stderr: string,
  reason?: BootFailureReason,
): string {
  const haystack = `${message}\n${stdout}\n${stderr}`.toLowerCase();
  if (haystack.includes('device is busy') && haystack.includes('connecting')) {
    return 'Target iOS device is still connecting. Keep it unlocked, wait for device trust/connection to settle, then retry.';
  }
  const classified = reason ?? 'IOS_RUNNER_CONNECT_TIMEOUT';
  // Clearing cached build products cannot put a device into a provisioning
  // profile, so that recovery advice is withheld where it would only add noise
  // to an already actionable instruction.
  if (classified === 'IOS_RUNNER_DEVICE_NOT_PROVISIONED') return bootFailureHint(classified);
  return `${bootFailureHint(classified)} ${RUNNER_CACHE_RECOVERY_HINT}`;
}

export function buildRunnerConnectError(params: {
  port: number;
  endpoints: string[];
  logPath?: string;
  lastError: unknown;
  deviceStates?: IosRunnerDeviceStates;
}): AppError {
  const { port, endpoints, logPath, lastError, deviceStates } = params;
  const message = 'Runner did not accept connection';
  const error = new AppError('COMMAND_FAILED', message, {
    port,
    endpoints,
    logPath,
    lastError: lastError ? String(lastError) : undefined,
    reason: classifyBootFailure({
      error: lastError,
      message,
      context: { platform: 'ios', phase: 'connect' },
    }),
    hint: bootFailureHint('IOS_RUNNER_CONNECT_TIMEOUT'),
  });
  // The other way the connect stage gives up: `xcodebuild` is still alive at the deadline. It gets
  // the same enrichment as the early exit below (#2683).
  return enrichRunnerStartupFailureWithDeviceStates(error, deviceStates) as AppError;
}

export async function buildRunnerEarlyExitError(params: {
  session: RunnerSession;
  port: number;
  logPath?: string;
}): Promise<AppError> {
  const { session, port, logPath } = params;
  const result = await session.testPromise;
  const message = 'Runner did not accept connection (xcodebuild exited early)';
  // The runner writes its own output file, so the exec result holds nothing for a file-backed
  // child; that file is what an early exit can quote (#2681).
  const output = session.readLogTail?.(RUNNER_EARLY_EXIT_LOG_TAIL_BYTES) ?? '';
  const reason = classifyBootFailure({
    message,
    stdout: output,
    stderr: output,
    context: { platform: 'ios', phase: 'connect' },
  });
  // exec-guard-allow: xcodebuild can exit 0 and still count as an early exit;
  // the trio is nested tool context under `xcodebuild`, classified into
  // `reason`/`hint` above — not a process-exit wrap.
  const error = new AppError('COMMAND_FAILED', message, {
    port,
    // The quote always comes from the runner's own file, so that is the file the error has to name;
    // pointing at the request's log would advertise a file that does not contain what is quoted (#2681).
    logPath: session.runnerLogPath ?? logPath,
    xcodebuild: {
      exitCode: result.exitCode,
      // One merged file since #2681: the tail is reported under `stderr`, which is where readers
      // already look, next to the file it came from.
      stderr: output,
    },
    reason,
    hint: resolveRunnerEarlyExitHint(message, output, output, reason),
  });
  // The build catch is not the only way a runner stops before serving a command. A locked phone lets
  // the build finish and kills `xcodebuild test-without-building` instead, so nothing reaches that
  // catch and the disk-image state read before the build would be dropped. Same enrichment, applied
  // to the failure this path actually produces (#2683).
  return enrichRunnerStartupFailureWithDeviceStates(error, session.startupDeviceStates) as AppError;
}
