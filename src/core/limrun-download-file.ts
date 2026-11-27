import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import {
  AppError,
  createRequestCanceledError,
  type ReasonTable,
} from '@agent-device/kernel/errors';
import type { LimrunFileDownload } from '@agent-device/provider-limrun';
import { assertSecureCredentialTransport } from '@agent-device/contracts/credential-transport';

const RESPONSE_BODY_PREVIEW_BYTES = 500;

// Why a Limrun file download did not land. The destination is removed on every failure, so each row
// means "retry from the same URL", and `limrun_download_failed` adds that the transport itself broke.
const LIMRUN_DOWNLOAD_REASONS = {
  // The service answered the download with an error status; `details.statusCode` and `details.body` carry its reply.
  httpError: { reason: 'limrun_download_http_error' },
  // The download passed its deadline; `details.timeoutMs` is that deadline.
  timeout: { reason: 'limrun_download_timeout' },
  // The transfer broke for a reason the service never answered with, kept in `details.cause`.
  failed: { reason: 'limrun_download_failed' },
} as const satisfies ReasonTable<'limrun'>;

/**
 * Streams one authenticated Limrun download to disk. The transfer is bounded by `timeoutMs`; a
 * failed or timed-out attempt leaves no file at the destination, so the caller can retry from the
 * same URL and never mistakes an earlier attempt's file for this one's.
 */
export async function downloadLimrunFile(options: LimrunFileDownload): Promise<void> {
  // The URL comes from the provider, and the headers carry its bearer token.
  if (options.headers && Object.keys(options.headers).length > 0) {
    assertSecureCredentialTransport(options.url, 'Limrun download URL');
  }
  const timeout = AbortSignal.timeout(options.timeoutMs);
  const signal = options.signal ? AbortSignal.any([timeout, options.signal]) : timeout;
  try {
    await fs.promises.mkdir(path.dirname(options.destinationPath), { recursive: true });
    const response = await fetch(options.url, {
      method: 'GET',
      headers: options.headers,
      signal,
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
      { signal },
    );
  } catch (error) {
    await fs.promises.rm(options.destinationPath, { force: true }).catch(() => {});
    throw downloadFailure(error, options, timeout, signal);
  }
}

async function httpFailure(response: Response, options: LimrunFileDownload): Promise<AppError> {
  return new AppError('COMMAND_FAILED', `Limrun download failed with HTTP ${response.status}`, {
    url: options.url,
    statusCode: response.status,
    reason: LIMRUN_DOWNLOAD_REASONS.httpError.reason,
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
  signal: AbortSignal,
): unknown {
  if (error instanceof AppError) return error;
  if (options.signal?.aborted && signal.reason === options.signal.reason) {
    const reason: unknown = options.signal.reason;
    if (reason instanceof AppError) return reason;
    if (!(reason instanceof Error && reason.name === 'TimeoutError')) {
      return createRequestCanceledError(undefined, reason);
    }
    return new AppError(
      'COMMAND_FAILED',
      'Limrun download deadline expired',
      {
        url: options.url,
        reason: LIMRUN_DOWNLOAD_REASONS.timeout.reason,
        timeoutMs: options.timeoutMs,
      },
      reason,
    );
  }
  if (timeout.aborted) {
    return new AppError('COMMAND_FAILED', 'Limrun download timed out', {
      url: options.url,
      timeoutMs: options.timeoutMs,
      reason: LIMRUN_DOWNLOAD_REASONS.timeout.reason,
    });
  }
  return new AppError('COMMAND_FAILED', 'Limrun download failed', {
    url: options.url,
    reason: LIMRUN_DOWNLOAD_REASONS.failed.reason,
    cause: error instanceof Error ? error.message : String(error),
  });
}
