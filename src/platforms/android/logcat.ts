import fs from 'node:fs';
import { AppError } from '../../kernel/errors.ts';
import { execFailureDetails } from '../../utils/exec.ts';
import type { AndroidAdbExecutor, AndroidAdbProcess, AndroidAdbProvider } from './adb-executor.ts';

export type AndroidLogcatCaptureOptions = {
  lines?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
};

export type AndroidLogcatStreamOptions = {
  pid?: string;
  signal?: AbortSignal;
  output?: fs.WriteStream;
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
    throw new AppError(
      'COMMAND_FAILED',
      'Failed to capture Android logcat',
      execFailureDetails(result),
    );
  }
  return result.stdout;
}

export function streamAndroidLogcatWithAdb(
  provider: Pick<AndroidAdbProvider, 'spawn'>,
  options: AndroidLogcatStreamOptions = {},
): AndroidAdbProcess {
  if (!provider.spawn) {
    throw new AppError('UNSUPPORTED_OPERATION', 'Android ADB provider does not support streams', {
      capability: 'adb.spawn',
    });
  }
  const args = ['logcat', '-v', 'time'];
  if (options.pid) {
    args.push('--pid', options.pid);
  }
  const child = provider.spawn(args, { stdio: ['ignore', 'pipe', 'pipe'], signal: options.signal });
  if (options.output && child.stdout) {
    child.stdout.pipe(options.output, { end: false });
  }
  return child;
}
