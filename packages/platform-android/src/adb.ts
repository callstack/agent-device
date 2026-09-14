import type { DeviceInfo } from '@agent-device/kernel/device';
import type { ShellWord } from '@agent-device/kernel/device-shell';
import {
  resolveAndroidAdbExecutor,
  runAdbExecOut,
  runAdbShell,
  type AndroidAdbExecutorOptions,
  type AndroidAdbExecutorResult,
} from './adb-executor.ts';

export { sleep } from '@agent-device/host-kit/retry';

/**
 * Runs a non-shell adb subcommand (`install`, `pull`, `reverse`, …) for the device. A
 * `shell`/`exec-out` argv is refused here; it belongs to {@link runAndroidShell}.
 */
export async function runAndroidAdb(
  device: DeviceInfo,
  args: readonly string[],
  options?: AndroidAdbExecutorOptions,
): Promise<AndroidAdbExecutorResult> {
  return await resolveAndroidAdbExecutor(device)(args, options);
}

/** Runs `adb shell <words>` for the device; every word is quoted for the device shell. */
export async function runAndroidShell(
  device: DeviceInfo,
  words: readonly ShellWord[],
  options?: AndroidAdbExecutorOptions,
): Promise<AndroidAdbExecutorResult> {
  return await runAdbShell(resolveAndroidAdbExecutor(device), words, options);
}

/** Runs `adb exec-out <words>` (raw stdout) for the device. */
export async function runAndroidExecOut(
  device: DeviceInfo,
  words: readonly ShellWord[],
  options?: AndroidAdbExecutorOptions,
): Promise<AndroidAdbExecutorResult> {
  return await runAdbExecOut(resolveAndroidAdbExecutor(device), words, options);
}

/**
 * Whether an adb `cmd <service> <command>` invocation was refused because this build ships no
 * shell implementation for it, rather than because the call itself failed.
 *
 * adb reports this condition in its output and nowhere else — no exit code or structured field
 * separates "service has no shell command" from any other non-zero result — so this is the one
 * place that reads that prose, and it hands every caller a typed answer instead.
 *
 * Only ever ask this about a call that *failed*. A command that succeeds prints its own payload
 * on stdout — `clipboard get text` returns arbitrary user text, which may quote these very
 * phrases — so callers must settle a zero exit before reaching for this.
 */
export function isAndroidShellCommandUnsupported(stdout: string, stderr: string): boolean {
  const haystack = `${stdout}\n${stderr}`.toLowerCase();
  return (
    haystack.includes('no shell command implementation') || haystack.includes('unknown command')
  );
}
