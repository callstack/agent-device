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
 * Whether an adb `cmd clipboard` invocation was refused because this build ships no shell
 * implementation for the clipboard service, rather than because the call itself failed.
 *
 * adb reports this condition in its output and nowhere else — no exit code or structured field
 * separates "service has no shell command" from any other non-zero result — so this is the one
 * place that reads that prose, and it hands every caller a typed answer instead.
 *
 * Only ever ask this about a call that *failed*. A successful `clipboard get text` returns the
 * clipboard's contents on stdout, which is arbitrary user text and may quote these very phrases;
 * callers must settle a zero exit as success before reaching for this.
 */
export function isClipboardShellUnsupported(stdout: string, stderr: string): boolean {
  const haystack = `${stdout}\n${stderr}`.toLowerCase();
  return (
    haystack.includes('no shell command implementation') || haystack.includes('unknown command')
  );
}
