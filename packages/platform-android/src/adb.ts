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
