import { androidAdbResultError, type AndroidAdbExecutor } from './adb-executor.ts';

export type AndroidLogcatCaptureOptions = {
  lines?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
};

export async function captureAndroidLogcatWithAdb(
  adb: AndroidAdbExecutor,
  options: AndroidLogcatCaptureOptions = {},
): Promise<string> {
  const args = ['logcat', '-d', '-v', 'time'];
  if (options.lines !== undefined) {
    args.push('-t', String(Math.max(1, Math.floor(options.lines))));
  }
  const result = await adb(args, {
    allowFailure: true,
    timeoutMs: options.timeoutMs,
    signal: options.signal,
  });
  if (result.exitCode !== 0) {
    throw androidAdbResultError('Failed to capture Android logcat', result);
  }
  return result.stdout;
}
