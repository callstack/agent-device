import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { AppError } from '@agent-device/kernel/errors';
import type { LimrunFileDownload } from '@agent-device/provider-limrun';

const RESPONSE_BODY_PREVIEW_BYTES = 500;

/**
 * Streams one authenticated Limrun download to disk. The transfer is bounded by `timeoutMs`; a
 * failed or timed-out attempt leaves no file at the destination, so the caller can retry from the
 * same URL and never mistakes an earlier attempt's file for this one's.
 */
export async function downloadLimrunFile(options: LimrunFileDownload): Promise<void> {
  const timeout = AbortSignal.timeout(options.timeoutMs);
  try {
    await fs.promises.mkdir(path.dirname(options.destinationPath), { recursive: true });
    const response = await fetch(options.url, {
      method: 'GET',
      headers: options.headers,
      signal: timeout,
    });
    if (!response.ok) throw await httpFailure(response, options);
    if (!response.body) {
      throw new AppError('COMMAND_FAILED', 'Limrun download returned no body', {
        url: options.url,
      });
    }
    await pipeline(
      Readable.fromWeb(response.body as WebReadableStream<Uint8Array>),
      fs.createWriteStream(options.destinationPath),
      { signal: timeout },
    );
  } catch (error) {
    await fs.promises.rm(options.destinationPath, { force: true }).catch(() => {});
    throw downloadFailure(error, options, timeout);
  }
}

async function httpFailure(response: Response, options: LimrunFileDownload): Promise<AppError> {
  return new AppError('COMMAND_FAILED', `Limrun download failed with HTTP ${response.status}`, {
    url: options.url,
    statusCode: response.status,
    body: await readBodyPreview(response),
  });
}

/** Reads at most the preview's bytes of an error body; a body that stalls fails like the transfer. */
async function readBodyPreview(response: Response): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (bytes < RESPONSE_BODY_PREVIEW_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      const room = RESPONSE_BODY_PREVIEW_BYTES - bytes;
      chunks.push(value.subarray(0, room));
      bytes += value.byteLength;
    }
  } finally {
    void reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks).toString('utf8');
}

function downloadFailure(
  error: unknown,
  options: LimrunFileDownload,
  timeout: AbortSignal,
): unknown {
  if (timeout.aborted) {
    return new AppError('COMMAND_FAILED', 'Limrun download timed out', {
      url: options.url,
      timeoutMs: options.timeoutMs,
    });
  }
  if (error instanceof AppError) return error;
  return new AppError('COMMAND_FAILED', 'Limrun download failed', {
    url: options.url,
    reason: error instanceof Error ? error.message : String(error),
  });
}
