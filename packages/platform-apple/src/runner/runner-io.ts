import fs from 'node:fs';
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
