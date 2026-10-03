import type { AndroidClipboardShellSupport } from '@agent-device/contracts/android-clipboard-support';
import { AppError } from '@agent-device/kernel/errors';
import type { AndroidAdbExecutorResult } from './adb-executor.ts';
import { isAndroidShellCommandUnsupported, reportsAndroidNoShellCommand } from './adb.ts';

/** What the device answered an `adb shell cmd clipboard …` call. */
export type AndroidClipboardShellVerdict = 'executed' | 'no-shell-command' | 'call-failed';

/** Which clipboard subcommand was called, shared by the refusal wording and the reason. */
export type AndroidClipboardOperation = 'read' | 'write';

export const ANDROID_CLIPBOARD_SHELL_COMMAND_UNAVAILABLE_REASON =
  'android_clipboard_shell_command_unavailable' as const;

/**
 * What to do instead, carried by both the fact that refuses admission and the error that refuses
 * execution: the substitute is a device-side check, never another adb attempt.
 */
export const ANDROID_CLIPBOARD_SHELL_COMMAND_UNAVAILABLE_HINT =
  'This Android build ships no shell implementation for the clipboard service, so adb cannot read or write the clipboard on it. Verify a copy flow by pasting into a focused field and reading that field back.';

/**
 * Classifies one clipboard shell call from what the device said about it.
 *
 * A zero exit status does not settle whether the clipboard service ran the command: a service that
 * implements no shell command prints `No shell command implementation.` to its **err** descriptor
 * and returns 0 (`Binder.handleShellCommand`'s framework default, which is what Android's
 * `ClipboardService` falls back to). So that sentence is evidence at every exit status, and it wins
 * even against a non-empty stdout, because a service that never ran the command produced no payload
 * for stdout to hold.
 *
 * Nothing else about a clean exit is evidence of refusal. A read that ran answers on stdout with
 * arbitrary user text, which may quote any of these phrases, and the generic missing-subcommand
 * prose is adb's own wording too — it can describe the client, not this device — so both are read
 * only once the call has actually failed.
 */
export function classifyAndroidClipboardShellResponse(
  result: Pick<AndroidAdbExecutorResult, 'exitCode' | 'stdout' | 'stderr'>,
): AndroidClipboardShellVerdict {
  if (reportsAndroidNoShellCommand(result.stderr)) return 'no-shell-command';
  if (result.exitCode !== 0) {
    return isAndroidShellCommandUnsupported(result.stdout, result.stderr)
      ? 'no-shell-command'
      : 'call-failed';
  }
  return 'executed';
}

/**
 * Translates the execution verdict into the admission verdict the clipboard facts are stated in.
 * A build that refused the probe's command will refuse the next one too, while a call that never
 * reached a build proves nothing about it.
 */
export function androidClipboardShellSupportForVerdict(
  verdict: AndroidClipboardShellVerdict,
): AndroidClipboardShellSupport {
  if (verdict === 'executed') return 'supported';
  return verdict === 'no-shell-command' ? 'unsupported' : 'probe-failed';
}

/**
 * The admission verdict for one probe call, for a caller that holds only what adb answered. The
 * verdict vocabulary stays here: a caller that composes it itself would have to know which
 * sentences outrank which streams, which is the part only this owner should assert.
 */
export function androidClipboardShellSupportForResult(
  result: Pick<AndroidAdbExecutorResult, 'exitCode' | 'stdout' | 'stderr'>,
): AndroidClipboardShellSupport {
  return androidClipboardShellSupportForVerdict(classifyAndroidClipboardShellResponse(result));
}

/**
 * The refusal for a build whose clipboard service exposes no shell command: not retryable, and not
 * a permission to ask for, so it carries the substitute hint rather than a retriable detail.
 */
export function androidClipboardShellCommandUnavailableError(
  operation: AndroidClipboardOperation,
): AppError {
  return new AppError(
    'UNSUPPORTED_OPERATION',
    `Android shell clipboard ${operation} is not supported on this device.`,
    {
      reason: ANDROID_CLIPBOARD_SHELL_COMMAND_UNAVAILABLE_REASON,
      hint: ANDROID_CLIPBOARD_SHELL_COMMAND_UNAVAILABLE_HINT,
    },
  );
}
