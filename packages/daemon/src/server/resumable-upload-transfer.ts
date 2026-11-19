import fs from 'node:fs';
import crypto from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { pipeline } from 'node:stream/promises';
import { AppError } from '@agent-device/kernel/errors';
import { createByteLimitStream } from '@agent-device/host-kit/archive';
import { parseUploadContentLength, parseUploadContentRange } from './resumable-upload-range.ts';
import { resolveIngressFailure, throwIfIngressAborted } from './upload-ingress.ts';

export type ResumableTransferEntry = {
  payloadPath: string;
  sizeBytes: number;
};

export async function receiveResumableTransfer(params: {
  entry: ResumableTransferEntry;
  req: IncomingMessage;
  invalidate: (error: unknown) => Promise<void>;
  signal?: AbortSignal;
  onAcceptedBytes?: (bytes: number) => void;
  onBodyComplete?: () => void;
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
  const payloadStream = fs.createWriteStream(params.entry.payloadPath, { flags: 'a' });
  observeAcceptedWrites(payloadStream, params.onAcceptedBytes);
  let offset: number;
  try {
    await pipeline(params.req, limiter, payloadStream, { signal: params.signal });
    if (range && limiter.bytesSeen !== range.span) {
      throw new AppError('INVALID_ARGS', 'Upload chunk length does not match content-range');
    }
    if (contentLength !== undefined && limiter.bytesSeen !== contentLength) {
      throw new AppError('INVALID_ARGS', 'Upload chunk length does not match content-length');
    }
    // The body is complete: inactivity no longer applies to this request, so valid
    // post-body work observes only the owner's aggregate (#4441).
    params.onBodyComplete?.();
    // The final offset check and the owner's last cancellation check stay inside the
    // rollback boundary: a cancelled chunk never commits its offset (#4441).
    offset = await currentOffset(params.entry);
    throwIfIngressAborted(params.signal);
  } catch (error) {
    // An aborted ingress signal owns the failure with its typed reason; an earlier
    // classified failure (limiter, ticket expiry) is preserved unchanged (#4441).
    const failure = resolveIngressFailure(params.signal, error);
    await rollback(params.entry.payloadPath, oldSize, failure, params.invalidate);
    throw failure;
  }
  return { complete: offset === params.entry.sizeBytes, offset, appended: offset > oldSize };
}

/**
 * Reports each nonempty chunk only after its write to the payload file completed
 * without error: completed-byte progress, never bytes merely read from the socket.
 * The wrapper preserves the caller's arguments and callback.
 */
export function observeAcceptedWrites(
  stream: fs.WriteStream,
  onAcceptedBytes: ((bytes: number) => void) | undefined,
): void {
  if (!onAcceptedBytes) return;
  const originalWrite = stream.write.bind(stream);
  stream.write = function (
    chunk: unknown,
    encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
    callback?: (error?: Error | null) => void,
  ): boolean {
    const encoding = typeof encodingOrCallback === 'string' ? encodingOrCallback : undefined;
    const callerCallback = typeof encodingOrCallback === 'function' ? encodingOrCallback : callback;
    const bytes =
      typeof chunk === 'string'
        ? Buffer.byteLength(chunk, encoding ?? 'utf8')
        : Buffer.isBuffer(chunk) || ArrayBuffer.isView(chunk)
          ? chunk.byteLength
          : 0;
    return originalWrite(chunk as never, encoding as never, (error?: Error | null) => {
      if (!error && bytes > 0) onAcceptedBytes(bytes);
      callerCallback?.(error);
    });
  } as typeof stream.write;
}

/**
 * Hashes a received payload under the ingress owner's signal when given: the read
 * stream is destroyed with the owner's typed reason on abort, and an abort-owned
 * generic failure is mapped back to that reason. The file is bounded by the byte
 * cap that admitted it.
 */
export async function computeUploadHash(filePath: string, signal?: AbortSignal): Promise<string> {
  const hash = crypto.createHash('sha256');
  try {
    const stream = fs.createReadStream(filePath, signal ? { signal } : undefined);
    for await (const chunk of stream) {
      signal?.throwIfAborted();
      hash.update(chunk);
    }
  } catch (error) {
    throw resolveIngressFailure(signal, error);
  }
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
