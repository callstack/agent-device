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

/**
 * The append failure each log path is carrying, if any, cleared by the next append that succeeded. A
 * lost write is the reason a byte offset stops being a boundary, and the queue outlives it.
 */
const logAppendLosses = new Map<string, unknown>();

function appendLogChunk(logPath: string, chunk: string): void {
  const previous = logAppendQueues.get(logPath) ?? Promise.resolve();
  // A failed append is kept on the chain instead of being swallowed: whoever waits for these bytes has
  // to learn the disk refused them, because an offset measured over bytes that never landed would
  // credit the next command with output it did not produce (#2683 review). The failure does not stop
  // the queue — later output is still worth recording — and the no-op handler below keeps an append
  // nobody waited for from becoming an unhandled rejection.
  const written = previous.then(
    () => writeChunk(logPath, chunk),
    () => writeChunk(logPath, chunk),
  );
  // The failure is recorded rather than dropped, and the queue keeps going: later output is still worth
  // writing, while everything measured over a lost write is untrustworthy until an append succeeds
  // again (#2683 review).
  const accounted = written.then(
    () => {
      logAppendLosses.delete(logPath);
    },
    (error: unknown) => {
      logAppendLosses.set(logPath, error);
    },
  );
  const queued = accounted.finally(() => {
    if (logAppendQueues.get(logPath) === queued) {
      logAppendQueues.delete(logPath);
    }
  });
  logAppendQueues.set(logPath, queued);
}

async function writeChunk(logPath: string, chunk: string): Promise<void> {
  await fs.promises.mkdir(path.dirname(logPath), { recursive: true });
  await fs.promises.appendFile(logPath, chunk);
}

/** How long a log flush may take before whoever asked gives up on the tail. */
const RUNNER_LOG_FLUSH_TIMEOUT_MS = 2_000;

/**
 * Waits for the appends already queued for `logPath` to reach disk. `appendLogChunk` serialises
 * writes on a promise chain, so bytes an earlier command produced can still be in flight when a
 * later command marks the end of the log; measuring without this would hand those bytes to the
 * command that did not write them (#2683).
 *
 * Bounded, and honest about both ways it can fail to finish (#2683 review): a wedged append or a
 * caller that stopped waiting rejects rather than hanging the caller, and an append the disk refused
 * rejects too. Callers that are measuring a log boundary for diagnostics treat any rejection as "this
 * tail is unmeasurable" rather than as a clean offset.
 */
export async function flushRunnerLogAppends(
  logPath: string,
  budget: Readonly<{ timeoutMs?: number; signal?: AbortSignal }> = {},
): Promise<void> {
  const signal = AbortSignal.any([
    budget.signal ?? new AbortController().signal,
    AbortSignal.timeout(budget.timeoutMs ?? RUNNER_LOG_FLUSH_TIMEOUT_MS),
  ]);
  if (signal.aborted) throw signal.reason;

  const pending = logAppendQueues.get(logPath);
  if (pending) {
    let onAbort: () => void = () => {};
    try {
      await Promise.race([
        pending,
        new Promise<never>((_resolve, reject) => {
          onAbort = () => reject(signal.reason);
          signal.addEventListener('abort', onAbort, { once: true });
        }),
      ]);
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
  }
  // Checked whether or not anything was queued, so an append that failed and was forgotten by the queue
  // still reaches whoever is about to measure this file.
  const lost = logAppendLosses.get(logPath);
  if (lost !== undefined) throw lost;
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

/**
 * One runner generation's view of the log file it was launched onto (#2681).
 *
 * The file outlives the generation that appended to it, so every reader needs to know where its
 * own generation began: bytes below `startOffset` were written by an older runner, and quoting them
 * as this one's output would classify a boot failure this launch never produced.
 */
export type RunnerLogFile = Readonly<{
  logPath: string;
  startOffset: number;
}>;

/**
 * Opens one generation's view of a log file from the append-mode descriptor it was launched with:
 * an append descriptor opens at end-of-file, so the size behind it is this generation's start.
 */
export function createRunnerLogFile(logPath: string, outputFd: number): RunnerLogFile {
  let startOffset = 0;
  try {
    startOffset = fs.fstatSync(outputFd).size;
  } catch {}
  return { logPath, startOffset };
}

export type RunnerLogTail = Readonly<{
  /** Reads whatever the file gained since the last read, then stops polling. */
  drain(): void;
  /** Stops following the file and releases this process's read side of it. */
  stop(): void;
}>;

/**
 * Follows a log file the runner writes itself, starting where its generation starts.
 *
 * The child owns the write end, so the host reads the file back to see the listener-ready marker.
 * The tail is a latency hint, not a readiness proof — a file that cannot be read stops the tail and
 * startup ends on its own budget instead.
 */
export function tailRunnerLogFile(input: {
  file: RunnerLogFile;
  onOutput(chunk: string): void;
  pollMs?: number;
}): RunnerLogTail {
  const pollMs = input.pollMs ?? RUNNER_LOG_TAIL_DEFAULT_POLL_MS;
  const buffer = Buffer.alloc(RUNNER_LOG_TAIL_CHUNK_BYTES);
  let offset = input.file.startOffset;
  let readFd: number | null = null;
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;

  const drain = (): void => {
    if (stopped) return;
    try {
      readFd ??= fs.openSync(input.file.logPath, 'r');
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
 * The tail of one generation's runner log: what an early-exit error can quote when the runner's
 * output went to the file instead of a pipe (#2681). Bounded to the bytes this generation wrote —
 * an older runner's boot failure in the same file must not become this launch's recovery hint — and
 * to `maxBytes` from there. Empty when the file is unreadable or this generation wrote nothing.
 */
export function readRunnerLogTail(file: RunnerLogFile | undefined, maxBytes: number): string {
  if (!file) return '';
  let fd: number | null = null;
  try {
    fd = fs.openSync(file.logPath, 'r');
    const size = fs.fstatSync(fd).size;
    const from = Math.max(file.startOffset, size - maxBytes);
    const wanted = size - from;
    if (wanted <= 0) return '';
    const buffer = Buffer.alloc(wanted);
    const read = fs.readSync(fd, buffer, 0, wanted, from);
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
