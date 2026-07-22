import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { AppError } from '../kernel/errors.ts';

const MAX_ARTIFACT_BYTES = 2 * 1024 * 1024 * 1024; // 2 GB
const TEMP_PREFIX = 'agent-device-artifact-';
const REQUEST_IDLE_TIMEOUT_MS = 60_000;

export function sanitizeArtifactFilename(raw: string): string {
  const trimmed = raw.trim();
  const basename = path.basename(trimmed);
  if (!basename || basename === '.' || basename === '..') {
    throw new AppError('INVALID_ARGS', `Invalid artifact filename: ${raw}`);
  }
  return basename;
}

export function createArtifactTempDir(requestId?: string): string {
  const scope = sanitizeRequestId(requestId);
  return fs.mkdtempSync(path.join(os.tmpdir(), `${TEMP_PREFIX}${scope}-`));
}

export function validateArtifactContentLength(rawLength: string | number | undefined): void {
  if (rawLength === undefined) return;
  const parsed = Number(rawLength);
  // Ignore malformed content-length values; the streaming byte cap still enforces the hard limit.
  if (Number.isFinite(parsed) && parsed > MAX_ARTIFACT_BYTES) {
    throw new AppError(
      'INVALID_ARGS',
      `Upload exceeds maximum size of ${MAX_ARTIFACT_BYTES} bytes`,
    );
  }
}

export function streamReadableToFile(
  source: NodeJS.ReadableStream,
  destPath: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let bytesWritten = 0;
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const output = fs.createWriteStream(destPath);

    const settle = (error?: unknown) => {
      if (settled) return;
      settled = true;
      if (timeoutHandle) clearTimeout(timeoutHandle);
      if (error) {
        void removePartialFile(output, destPath).finally(() => reject(error));
        return;
      }
      resolve();
    };
    const armTimeout = () => {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      timeoutHandle = setTimeout(() => {
        const error = new AppError(
          'COMMAND_FAILED',
          'Artifact transfer timed out due to inactivity',
          {
            timeoutMs: REQUEST_IDLE_TIMEOUT_MS,
          },
        );
        if ('destroy' in source && typeof source.destroy === 'function') {
          source.destroy(error);
        }
        byteLimit.destroy(error);
        settle(error);
      }, REQUEST_IDLE_TIMEOUT_MS);
    };

    const byteLimit = new Transform({
      transform(chunk: Buffer | string, encoding, callback) {
        armTimeout();
        const size = Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk, encoding);
        bytesWritten += size;
        if (bytesWritten > MAX_ARTIFACT_BYTES) {
          callback(
            new AppError(
              'INVALID_ARGS',
              `Upload exceeds maximum size of ${MAX_ARTIFACT_BYTES} bytes`,
            ),
          );
          return;
        }
        callback(null, chunk);
      },
    });

    source.on('aborted', () => {
      settle(new AppError('COMMAND_FAILED', 'Artifact transfer was interrupted'));
    });
    armTimeout();
    void pipeline(source, byteLimit, output).then(
      () => settle(),
      (error: unknown) => settle(error),
    );
  });
}

async function removePartialFile(output: fs.WriteStream, destPath: string): Promise<void> {
  output.destroy();
  if (!output.closed) {
    try {
      await once(output, 'close');
    } catch {
      // best-effort cleanup only
    }
  }
  await fs.promises.rm(destPath, { force: true }).catch(() => {});
}

function sanitizeRequestId(raw: string | undefined): string {
  const trimmed = raw?.trim();
  if (!trimmed) return 'request';
  const normalized = trimmed.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return normalized.length > 0 ? normalized.slice(0, 48) : 'request';
}
