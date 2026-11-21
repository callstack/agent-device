import {
  AppError,
  type AppErrorCode,
  type AppErrorDetails,
  type ReasonTable,
} from '@agent-device/kernel/errors';

// Why a Limrun-hosted iOS runner could not be prepared, launched, or used. Every row's recovery is
// what a caller can still do from outside the remote instance, spelled out in `DEFAULT_HINTS`.
export const LIMRUN_RUNNER_REASONS = {
  // Another XCTest run holds the simulator's one run slot.
  xctestSlotOccupied: { reason: 'limrun_xctest_slot_occupied' },
  // The remote XCTest run could not be started, or its run stream never arrived.
  launchFailed: { reason: 'limrun_runner_launch_failed' },
  // The runner app or its manifest does not match the instance this client rented.
  productsInvalid: { reason: 'limrun_runner_products_invalid' },
  // The runner app could not be staged on the instance.
  uploadFailed: { reason: 'limrun_runner_upload_failed' },
  // The simulator never reported the address its HTTP forward listens on.
  bindAddressMissing: { reason: 'limrun_runner_bind_address_missing' },
  // The runner's snapshot capture came back too sparse to act on after a failed or unbudgeted capture.
  snapshotUnavailable: { reason: 'limrun_runner_snapshot_unavailable' },
} as const satisfies ReasonTable<'limrun'>;

/** How each {@link LIMRUN_RUNNER_REASONS} reason is recovered; a caller may replace it per error. */
const DEFAULT_HINTS: Readonly<
  Record<(typeof LIMRUN_RUNNER_REASONS)[keyof typeof LIMRUN_RUNNER_REASONS]['reason'], string>
> = {
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
  limrun_runner_snapshot_unavailable:
    'Close and reopen the agent-device session to restart its XCTest runner. If snapshots still fail on this reused simulator, recreate the Limrun instance. Use a screenshot and coordinate actions to inspect its current screen; do not reuse snapshot refs.',
};

/** The published reasons of {@link LIMRUN_RUNNER_REASONS}, which is what a call site names. */
export type LimrunRunnerFailure =
  (typeof LIMRUN_RUNNER_REASONS)[keyof typeof LIMRUN_RUNNER_REASONS]['reason'];

export function limrunRunnerError(
  reason: LimrunRunnerFailure,
  message: string,
  details: AppErrorDetails = {},
  code: AppErrorCode = 'COMMAND_FAILED',
): AppError {
  return new AppError(code, message, {
    ...details,
    reason,
    hint: details.hint ?? DEFAULT_HINTS[reason],
  });
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
          hint: DEFAULT_HINTS[LIMRUN_RUNNER_REASONS.launchFailed.reason],
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
          reason: LIMRUN_RUNNER_REASONS.snapshotUnavailable.reason,
          hint: DEFAULT_HINTS[LIMRUN_RUNNER_REASONS.snapshotUnavailable.reason],
        },
        error,
      );
    }
    throw error;
  }
}
