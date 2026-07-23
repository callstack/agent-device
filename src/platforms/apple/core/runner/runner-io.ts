import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { AppError } from '../../../../kernel/errors.ts';

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
