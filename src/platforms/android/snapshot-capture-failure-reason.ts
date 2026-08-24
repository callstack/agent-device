import type { AndroidCaptureFailureReason } from '@agent-device/contracts/android-snapshot-quality';

/**
 * Machine-defined signals that mean an Android capture failed because the accessibility
 * hierarchy never arrived, mapped to the typed reason readers consume (#1983).
 *
 * Both signals are values, not prose. `errorType` is the helper's own Java class name, emitted
 * as a structured `INSTRUMENTATION_RESULT` field, and 137 is the shell's SIGKILL exit code. The
 * classification therefore survives any rewording of helper or wrapper messages, and prose that
 * merely reads like a timeout is not classified as one.
 */
const HELPER_TIMEOUT_ERROR_TYPE = 'java.util.concurrent.TimeoutException';

/** `am instrument` killed mid-run (128 + SIGKILL): the helper never got to report anything. */
const INSTRUMENTATION_KILLED_EXIT_CODE = 137;

/** The reason a helper result's structured `errorType` names, if any. */
export function androidCaptureFailureReasonFromHelperResult(
  helper: Readonly<Record<string, string | undefined>>,
): AndroidCaptureFailureReason | undefined {
  return helper.errorType === HELPER_TIMEOUT_ERROR_TYPE ? 'accessibility-timeout' : undefined;
}

/** The reason an `am instrument` exit code names, if any. */
export function androidCaptureFailureReasonFromExitCode(
  exitCode: number | undefined,
): AndroidCaptureFailureReason | undefined {
  return exitCode === INSTRUMENTATION_KILLED_EXIT_CODE ? 'accessibility-timeout' : undefined;
}

/**
 * The typed reason as an error-details fragment, spreadable into an `AppError`'s details. Absent
 * rather than `undefined` when there is no reason, so an unclassified failure carries no key.
 */
export function androidCaptureFailureReasonDetail(
  reason: AndroidCaptureFailureReason | undefined,
): { androidCaptureFailureReason?: AndroidCaptureFailureReason } {
  return reason ? { androidCaptureFailureReason: reason } : {};
}
