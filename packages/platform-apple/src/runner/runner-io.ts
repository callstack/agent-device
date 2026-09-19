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

/**
 * Waits for the appends already queued for `logPath` to reach disk. `appendLogChunk` serialises
 * writes on a promise chain, so bytes an earlier command produced can still be in flight when a
 * later command marks the end of the log; measuring without this would hand those bytes to the
 * command that did not write them (#2683).
 */
export async function flushRunnerLogAppends(logPath: string): Promise<void> {
  await logAppendQueues.get(logPath);
}

export function cleanupTempFile(filePath: string): void {
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch {}
}
