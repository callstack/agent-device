import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { AppError } from '@agent-device/kernel/errors';

export async function getFreePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (typeof address === 'object' && address?.port) {
        const port = address.port;
        server.close(() => resolve(port));
      } else {
        server.close(() => reject(new AppError('COMMAND_FAILED', 'Failed to allocate port')));
      }
    });
    server.on('error', reject);
  });
}

export function logChunk(
  chunk: string,
  logPath?: string,
  traceLogPath?: string,
  verbose?: boolean,
): void {
  if (logPath) appendLogChunk(logPath, chunk);
  if (traceLogPath) appendLogChunk(traceLogPath, chunk);
  if (verbose) {
    process.stderr.write(chunk);
  }
}

const logAppendQueues = new Map<string, Promise<void>>();

function appendLogChunk(logPath: string, chunk: string): void {
  const previous = logAppendQueues.get(logPath) ?? Promise.resolve();
  const next = previous
    .catch(() => {})
    .then(async () => {
      await fs.promises.mkdir(path.dirname(logPath), { recursive: true });
      await fs.promises.appendFile(logPath, chunk);
    })
    .catch(() => {});
  const queued = next.finally(() => {
    if (logAppendQueues.get(logPath) === queued) {
      logAppendQueues.delete(logPath);
    }
  });
  logAppendQueues.set(logPath, queued);
}

export function cleanupTempFile(filePath: string): void {
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch {}
}

/**
 * The file a runner generation writes its own output to, handed to the child as its stdout/stderr
 * so a detached runner never owns a pipe this process can close under it (#2681).
 *
 * A request always carries the session's `runner.log`. A runner started without one still needs a
 * file rather than a pipe, so it gets the shared per-device scratch log.
 */
export function resolveRunnerLaunchLogPath(logPath: string | undefined, deviceId: string): string {
  if (logPath) return logPath;
  const safeDeviceId = deviceId.replaceAll(/[^A-Za-z0-9._-]/g, '_');
  return path.join(os.tmpdir(), 'agent-device', 'apple-runner', 'logs', `${safeDeviceId}.log`);
}

const RUNNER_LOG_TAIL_DEFAULT_POLL_MS = 50;
const RUNNER_LOG_TAIL_CHUNK_BYTES = 64 * 1024;

export type RunnerLogTail = Readonly<{
  /** Reads whatever the file gained since the last read, then stops polling. */
  drain(): void;
  /** Stops following the file and releases this process's read side of it. */
  stop(): void;
}>;

/**
 * Follows a log file the runner writes itself, starting at an offset the launcher recorded.
 *
 * This is how the launcher still sees the listener-ready marker after #2681 moved the runner's
 * stdio onto a file: the child owns the write end, so the host reads the file back. The tail is a
 * latency hint, not a readiness proof — a file that cannot be read stops the tail and startup ends
 * on its own budget instead.
 */
export function tailRunnerLogFile(input: {
  logPath: string;
  offset: number;
  onOutput(chunk: string): void;
  pollMs?: number;
}): RunnerLogTail {
  const pollMs = input.pollMs ?? RUNNER_LOG_TAIL_DEFAULT_POLL_MS;
  const buffer = Buffer.alloc(RUNNER_LOG_TAIL_CHUNK_BYTES);
  let offset = input.offset;
  let readFd: number | null = null;
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;

  const drain = (): void => {
    if (stopped) return;
    try {
      readFd ??= fs.openSync(input.logPath, 'r');
      let size = fs.fstatSync(readFd).size;
      // A truncated or replaced log restarts the tail rather than reading across the gap.
      if (size < offset) offset = 0;
      while (offset < size) {
        const wanted = Math.min(buffer.length, size - offset);
        const read = fs.readSync(readFd, buffer, 0, wanted, offset);
        if (read <= 0) break;
        offset += read;
        input.onOutput(buffer.toString('utf8', 0, read));
        size = fs.fstatSync(readFd).size;
      }
    } catch {
      stop();
    }
  };

  const schedule = (): void => {
    if (stopped) return;
    timer = setTimeout(() => {
      drain();
      schedule();
    }, pollMs);
    timer.unref?.();
  };

  function stop(): void {
    if (stopped) return;
    stopped = true;
    if (timer) clearTimeout(timer);
    timer = null;
    if (readFd !== null) {
      try {
        fs.closeSync(readFd);
      } catch {}
      readFd = null;
    }
  }

  schedule();
  return {
    drain: () => {
      drain();
      stop();
    },
    stop,
  };
}

/**
 * The tail of a runner log file: what an early-exit error can quote when the runner's output went
 * to the file instead of a pipe (#2681). Empty when the file is unreadable.
 */
export function readRunnerLogTail(logPath: string | undefined, maxBytes: number): string {
  if (!logPath) return '';
  let fd: number | null = null;
  try {
    fd = fs.openSync(logPath, 'r');
    const size = fs.fstatSync(fd).size;
    const wanted = Math.min(size, maxBytes);
    if (wanted <= 0) return '';
    const buffer = Buffer.alloc(wanted);
    const read = fs.readSync(fd, buffer, 0, wanted, size - wanted);
    return buffer.toString('utf8', 0, Math.max(read, 0));
  } catch {
    return '';
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {}
    }
  }
}
