import fs from 'node:fs';
import path from 'node:path';
import { isLoopbackUrlHostname } from '@agent-device/host-kit/transport';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import {
  AppError,
  createRequestCanceledError,
  type ReasonTable,
} from '@agent-device/kernel/errors';
import type { LimrunFileDownload } from './runtime-dependencies.ts';

/** Every `details.reason` a Limrun file download publishes. */
const LIMRUN_DOWNLOAD_REASONS = {
  // The instance answered the download with no body at all, so nothing could reach disk.
  emptyBody: { reason: 'limrun_download_empty_body' },
  // The instance refused the download; its HTTP status answers for the refusal.
  httpError: { reason: 'limrun_download_http_error' },
  // The transfer's own deadline passed before the file reached disk.
  timeout: { reason: 'limrun_download_timeout' },
  // The transfer failed before it could ask the instance for the file.
  failed: { reason: 'limrun_download_failed' },
  // An authenticated download must use the instance origin and a secure transport.
  endpointBlocked: { reason: 'limrun_download_endpoint_blocked' },
} as const satisfies ReasonTable<'limrun'>;

/**
 * Streams one authenticated Limrun download to disk. The transfer is bounded by `timeoutMs`; a
 * failed or timed-out attempt leaves no file at the destination, so the caller can retry from the
 * same URL and never mistakes an earlier attempt's file for this one's.
 *
 * The destination is chosen by the caller. Download URLs and transport messages stay private.
 */
export async function downloadLimrunFile(options: LimrunFileDownload): Promise<void> {
  const timeout = AbortSignal.timeout(options.timeoutMs);
  const signal = options.signal ? AbortSignal.any([timeout, options.signal]) : timeout;
  try {
    const { instance } = options;
    const url = instance ? instanceDownloadUrl(instance.apiUrl, options.url) : options.url;
    await fs.promises.mkdir(path.dirname(options.destinationPath), { recursive: true });
    const response = await fetch(url, {
      method: 'GET',
      headers: instance ? { Authorization: `Bearer ${instance.token}` } : undefined,
      redirect: instance ? 'error' : 'follow',
      signal,
    });
    if (!response.ok) throw httpFailure(response);
    if (!response.body) {
      throw new AppError('COMMAND_FAILED', 'Limrun download returned no body', {
        reason: LIMRUN_DOWNLOAD_REASONS.emptyBody.reason,
        destination: path.basename(options.destinationPath),
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

function instanceDownloadUrl(apiUrl: string, value: string): URL {
  const url = URL.parse(value);
  const instance = URL.parse(apiUrl);
  if (!url || !instance) throw new TypeError('Invalid Limrun download endpoint.');
  const secure =
    url.protocol === 'https:' || (url.protocol === 'http:' && isLoopbackUrlHostname(url.hostname));
  if (url.origin !== instance.origin || url.username || url.password || !secure) {
    throw new AppError('COMMAND_FAILED', 'Limrun refused the authenticated download endpoint.', {
      reason: LIMRUN_DOWNLOAD_REASONS.endpointBlocked.reason,
    });
  }
  return url;
}

/**
 * Refuses a download by its HTTP status. The peer's body is deliberately unread: it is the peer's own
 * text and this request is authenticated with a token the peer can echo, so a published preview could
 * carry that token out with or without its label. `statusCode` is what a caller acts on — a missing
 * recording and a missing file are both a 404 answer, not a failure of the transfer.
 */
function httpFailure(response: Response): AppError {
  void response.body?.cancel().catch(() => {});
  return new AppError('COMMAND_FAILED', `Limrun download failed with HTTP ${response.status}`, {
    statusCode: response.status,
    reason: LIMRUN_DOWNLOAD_REASONS.httpError.reason,
  });
}

/**
 * Names why a download did not reach disk. A fetch failure's own text is not published: it can quote
 * the request URL, and this request's URL can be the caller's instance token. The failure is answered
 * by its typed reason and by the transport class: a rejected URL, a refused connection, or an
 * interrupted transfer.
 */
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
    return new AppError('COMMAND_FAILED', 'Limrun download deadline expired', {
      reason: LIMRUN_DOWNLOAD_REASONS.timeout.reason,
      timeoutMs: options.timeoutMs,
      transport: transportSummary(error),
    });
  }
  if (timeout.aborted) {
    return new AppError('COMMAND_FAILED', 'Limrun download timed out', {
      reason: LIMRUN_DOWNLOAD_REASONS.timeout.reason,
      timeoutMs: options.timeoutMs,
    });
  }
  return new AppError('COMMAND_FAILED', 'Limrun download failed', {
    reason: LIMRUN_DOWNLOAD_REASONS.failed.reason,
    transport: transportSummary(error),
  });
}

/**
 * The transport's own code for a failure, without its message. `fetch` names a malformed request URL
 * with a `TypeError` and reports a socket failure with a Node code like `ECONNREFUSED`; both answer for
 * what went wrong without quoting the request it happened on.
 */
function transportSummary(error: unknown): string {
  if (error instanceof TypeError) return 'invalid-request';
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && code.length > 0 ? code : 'unknown';
}
