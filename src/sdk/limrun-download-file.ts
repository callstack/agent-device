import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { AppError } from '@agent-device/kernel/errors';
import type { LimrunFileDownload } from '@agent-device/provider-limrun';

const RESPONSE_BODY_PREVIEW_CHARS = 500;

/**
 * Streams one authenticated Limrun download to disk. The transfer is bounded by `timeoutMs` and
 * by the caller's `signal`; a failed or aborted transfer leaves no partial file behind, so the
 * caller can retry from the same URL.
 */
export async function downloadLimrunFile(options: LimrunFileDownload): Promise<void> {
  const timeout = AbortSignal.timeout(options.timeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  await fs.promises.mkdir(path.dirname(options.destinationPath), { recursive: true });
  let response: Response;
  try {
    response = await fetch(options.url, { method: 'GET', headers: options.headers, signal });
  } catch (error) {
    throw downloadFailure(error, options, timeout);
  }
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new AppError('COMMAND_FAILED', `Limrun download failed with HTTP ${response.status}`, {
      url: options.url,
      statusCode: response.status,
      body: body.slice(0, RESPONSE_BODY_PREVIEW_CHARS),
    });
  }
  if (!response.body) {
    throw new AppError('COMMAND_FAILED', 'Limrun download returned no body', { url: options.url });
  }
  try {
    await pipeline(
      Readable.fromWeb(response.body as WebReadableStream<Uint8Array>),
      fs.createWriteStream(options.destinationPath),
      { signal },
    );
  } catch (error) {
    await fs.promises.rm(options.destinationPath, { force: true }).catch(() => {});
    throw downloadFailure(error, options, timeout);
  }
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
  if (options.signal?.aborted) return options.signal.reason;
  if (error instanceof AppError) return error;
  return new AppError('COMMAND_FAILED', 'Limrun download failed', {
    url: options.url,
    reason: error instanceof Error ? error.message : String(error),
  });
}
