import type { HostCommandResult } from '@agent-device/contracts/platform-runtime-host';
import { execFailureDetails } from '@agent-device/host-kit/command';
import { AppError } from '@agent-device/kernel/errors';

// POSIX EBUSY. `simctl recordVideo` exits with this when CoreSimulator's shared
// `SimStreamProcessorService` still holds the one host-wide recording slot — either a live
// recording elsewhere or a prior recorder that died without a graceful detach (#2170).
const SIMCTL_HOST_RECORDING_BUSY_EXIT_CODE = 16;
const SIMCTL_HOST_RECORDING_BUSY_REASON = 'apple-simulator-host-recording-busy';
const SIMCTL_HOST_RECORDING_BUSY_HINT =
  'Another screen recording is active on this host, or a previous recorder died without detaching. Stop the other recording, or run `killall -9 SimStreamProcessorService` to clear the dangling stream service (it relaunches on demand), then retry.';

/**
 * Classify a `simctl recordVideo` start failure by its typed exit code. Returns `undefined` for
 * codes with no specific recovery so the caller keeps the generic exit-code message. Keyed on the
 * exit code — a signal death reports `exitCode: 1`, never 16 — never on the stderr text.
 */
export function classifyAppleSimulatorRecordingExit(
  result: HostCommandResult,
): AppError | undefined {
  const exitCode = result.exitCode;
  if (exitCode !== SIMCTL_HOST_RECORDING_BUSY_EXIT_CODE) return undefined;
  return new AppError(
    'COMMAND_FAILED',
    'simctl recordVideo could not start because the CoreSimulator host recording slot is busy (EBUSY)',
    execFailureDetails(
      { stdout: result.stdout, stderr: result.stderr, exitCode },
      {
        reason: SIMCTL_HOST_RECORDING_BUSY_REASON,
        hint: SIMCTL_HOST_RECORDING_BUSY_HINT,
      },
    ),
  );
}
