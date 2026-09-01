import fs from 'node:fs';
import crypto from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { pipeline } from 'node:stream/promises';
import { AppError } from '@agent-device/kernel/errors';
import { createByteLimitStream } from '@agent-device/host-kit/archive';
import { parseUploadContentLength, parseUploadContentRange } from './resumable-upload-range.ts';

export type ResumableTransferEntry = {
  payloadPath: string;
  sizeBytes: number;
};

export async function receiveResumableTransfer(params: {
  entry: ResumableTransferEntry;
  req: IncomingMessage;
  invalidate: (error: unknown) => Promise<void>;
}): Promise<{ complete: boolean; offset: number; appended: boolean }> {
  const oldSize = await currentOffset(params.entry);
  const range = parseUploadContentRange(
    params.req.headers['content-range'],
    params.entry.sizeBytes,
  );
  if (range && range.start !== oldSize) {
    return { complete: false, offset: oldSize, appended: false };
  }
  if (!range && oldSize > 0) return { complete: false, offset: oldSize, appended: false };
  const remaining = params.entry.sizeBytes - oldSize;
  const bodyLimit = range?.span ?? remaining;
  const contentLength = parseUploadContentLength(params.req.headers['content-length']);
  if (contentLength !== undefined && contentLength > bodyLimit) {
    throw new AppError('INVALID_ARGS', 'Upload chunk exceeds its permitted byte range');
  }
  if (range && contentLength !== undefined && contentLength !== range.span) {
    throw new AppError('INVALID_ARGS', 'Upload chunk length does not match content-range');
  }

  const limiter = createByteLimitStream({
    maxBytes: bodyLimit,
    createLimitError: () =>
      new AppError('INVALID_ARGS', 'Upload chunk exceeds its permitted byte range'),
  });
  try {
    await pipeline(
      params.req,
      limiter,
      fs.createWriteStream(params.entry.payloadPath, { flags: 'a' }),
    );
    if (range && limiter.bytesSeen !== range.span) {
      throw new AppError('INVALID_ARGS', 'Upload chunk length does not match content-range');
    }
    if (contentLength !== undefined && limiter.bytesSeen !== contentLength) {
      throw new AppError('INVALID_ARGS', 'Upload chunk length does not match content-length');
    }
  } catch (error) {
    await rollback(params.entry.payloadPath, oldSize, error, params.invalidate);
    throw error;
  }
  const offset = await currentOffset(params.entry);
  return { complete: offset === params.entry.sizeBytes, offset, appended: offset > oldSize };
}

export async function computeUploadHash(filePath: string): Promise<string> {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
}

async function currentOffset(entry: ResumableTransferEntry): Promise<number> {
  const stat = await fs.promises.stat(entry.payloadPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
  const size = stat?.size ?? 0;
  if (size > entry.sizeBytes) {
    throw new AppError('COMMAND_FAILED', 'Upload state is corrupt', {
      reason: 'UPLOAD_STATE_CORRUPT',
    });
  }
  return size;
}

async function rollback(
  payloadPath: string,
  oldSize: number,
  originalError: unknown,
  invalidate: (error: unknown) => Promise<void>,
): Promise<void> {
  try {
    await fs.promises.truncate(payloadPath, oldSize);
  } catch (cleanupError) {
    const failure = new AppError(
      'COMMAND_FAILED',
      'Upload rollback failed; the upload ticket was invalidated',
      { reason: 'UPLOAD_ROLLBACK_FAILED', originalError: String(originalError) },
      cleanupError,
    );
    await invalidate(failure);
    throw failure;
  }
}
