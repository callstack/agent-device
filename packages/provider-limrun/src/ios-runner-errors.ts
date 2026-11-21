import { AppError, type AppErrorCode, type AppErrorDetails } from '@agent-device/kernel/errors';

const hints = {
  limrun_xctest_slot_occupied:
    'Another XCTest run owns this simulator. Stop its agent-device or Appium session, wait for its run stream to close, then retry. If the previous client died and the slot stays occupied, recreate the Limrun instance.',
  limrun_runner_launch_failed:
    'Inspect runner.log and the Limrun XCTest stream. Use a simulator runner built for this instance’s Xcode and iOS runtime.',
  limrun_runner_products_invalid:
    'Set AGENT_DEVICE_LIMRUN_IOS_RUNNER_APP to the simulator runner .app built for this instance’s Xcode and iOS runtime, or use a matching release runner.',
  limrun_runner_upload_failed:
    'Check the Limrun instance connection and retry preparing the runner.',
  limrun_runner_bind_address_missing:
    'The simulator must expose USE_IP for HTTP forwarding. Check the instance connection and simulator configuration.',
} as const;

export function limrunRunnerError(
  reason: keyof typeof hints,
  message: string,
  details: AppErrorDetails = {},
  code: AppErrorCode = 'COMMAND_FAILED',
): AppError {
  return new AppError(code, message, { ...details, reason, hint: details.hint ?? hints[reason] });
}

/** Preserve the shared capture failure while naming the remote recovery action. */
export async function withLimrunRunnerErrors<T>(task: () => Promise<T>): Promise<T> {
  try {
    return await task();
  } catch (error) {
    if (!(error instanceof AppError)) throw error;
    if (error.details?.runnerConnectFailureReason) {
      throw new AppError(
        error.code,
        error.message,
        {
          ...error.details,
          hint: hints.limrun_runner_launch_failed,
        },
        error,
      );
    }
    const quality = error.details?.snapshotQuality as
      | { state?: string; reasonCode?: string }
      | undefined;
    if (
      (error.details?.reason === 'invalid-viewport' ||
        error.details?.reason === 'missing-viewport' ||
        error.details?.reason === 'empty-snapshot') &&
      quality?.state === 'sparse' &&
      (quality.reasonCode === 'capture-failed' || quality.reasonCode === 'budget')
    ) {
      throw new AppError(
        error.code,
        'The Limrun XCTest runner could not capture the simulator screen',
        {
          ...error.details,
          reason: 'limrun_runner_snapshot_unavailable',
          hint: 'Close and reopen the agent-device session to restart its XCTest runner. If snapshots still fail on this reused simulator, recreate the Limrun instance. Use a screenshot and coordinate actions to inspect its current screen; do not reuse snapshot refs.',
        },
        error,
      );
    }
    throw error;
  }
}
