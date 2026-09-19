import type { DeviceInfo } from '@agent-device/kernel/device';
import {
  resolveAndroidAdbExecutor,
  type AndroidAdbExecutorOptions,
  type AndroidAdbExecutorResult,
} from './adb-executor.ts';

export { sleep } from '@agent-device/host-kit/retry';

export async function runAndroidAdb(
  device: DeviceInfo,
  args: string[],
  options?: AndroidAdbExecutorOptions,
): Promise<AndroidAdbExecutorResult> {
  return await resolveAndroidAdbExecutor(device)(args, options);
}

const ANDROID_NO_SHELL_COMMAND_SENTENCE = 'no shell command implementation';
const ANDROID_UNKNOWN_SUBCOMMAND_PHRASE = 'unknown command';

/**
 * Whether one adb output stream carries the sentence a device prints when its service implements no
 * shell command at all: `Binder.handleShellCommand`'s framework default writes it to the **err**
 * descriptor and returns a **zero** status, so this sentence outranks the exit status — a clean exit
 * never discharges it. Ask it of a stream, never of a call: the `stdout` of a command with a payload
 * is that payload (`cmd clipboard get text` answers with arbitrary user text, which may quote this
 * sentence), so only `stderr` is prose about the call itself.
 */
export function reportsAndroidNoShellCommand(stream: string): boolean {
  return stream.toLowerCase().includes(ANDROID_NO_SHELL_COMMAND_SENTENCE);
}

/**
 * Whether a call that already failed was refused for having no shell implementation rather than by
 * the failure itself. Both streams are consulted here because a call that never ran produced no
 * payload to confuse with the prose, and the generic missing-subcommand wording counts: adb prints
 * it too, so on its own it says nothing about the device's service and never overrides a clean exit.
 */
export function isAndroidShellCommandUnsupported(stdout: string, stderr: string): boolean {
  const haystack = `${stdout}\n${stderr}`.toLowerCase();
  return (
    haystack.includes(ANDROID_NO_SHELL_COMMAND_SENTENCE) ||
    haystack.includes(ANDROID_UNKNOWN_SUBCOMMAND_PHRASE)
  );
}
