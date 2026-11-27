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
const MAX_DOWNLOAD_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

// Why a Limrun file download did not land. The destination is removed on every failure, so each row
// means "retry from the same URL", and `limrun_download_failed` adds that the transport itself broke.
const LIMRUN_DOWNLOAD_REASONS = {
  // The service answered the download with an error status; `details.statusCode` and `details.body` carry its reply.
  httpError: { reason: 'limrun_download_http_error' },
  // The download passed its deadline; `details.timeoutMs` is that deadline.
  timeout: { reason: 'limrun_download_timeout' },
  // The transfer broke for a reason the service never answered with, kept in `details.cause`.
  failed: { reason: 'limrun_download_failed' },
  // The download got a redirect it does not follow: off https to another origin, to a URL with a
  // username or password or one that does not parse, or past the fifth hop. Nothing was sent there.
  redirectRefused: { reason: 'limrun_download_redirect_refused' },
} as const satisfies ReasonTable<'limrun'>;

/**
 * Streams one authenticated Limrun download to disk. The transfer is bounded by `timeoutMs`; a
 * failed or timed-out attempt leaves no file at the destination, so the caller can retry from the
 * same URL and never mistakes an earlier attempt's file for this one's.
 */
export async function downloadLimrunFile(options: LimrunFileDownload): Promise<void> {
  const timeout = AbortSignal.timeout(options.timeoutMs);
  const signal = options.signal ? AbortSignal.any([timeout, options.signal]) : timeout;
  try {
    await fs.promises.mkdir(path.dirname(options.destinationPath), { recursive: true });
    const response = await fetchDownload(options, signal);
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

/**
 * Requests the download and follows its redirects itself. The URL comes from the provider and can
 * be signed, and the headers carry its bearer token, so every hop meets the credential transport
 * rule. A redirect is followed from https to https or on the same origin only, and the headers stay
 * behind once it leaves the origin.
 */
async function fetchDownload(options: LimrunFileDownload, signal: AbortSignal): Promise<Response> {
  const { fetchWithCredential } = await import('@agent-device/host-kit/direct-http');
  let url = assertSecureCredentialTransport(options.url, 'Limrun download URL');
  let headers = options.headers;
  for (let redirects = 0; ; redirects += 1) {
    const response = await fetchWithCredential(url.href, {
      method: 'GET',
      headers,
      redirect: 'manual',
      signal,
    });
    const location = response.headers.get('location');
    if (!REDIRECT_STATUSES.has(response.status) || location === null) return response;
    await response.body?.cancel().catch(() => undefined);
    const target = URL.parse(location, url);
    if (!target || !isFollowedRedirect(url, target) || redirects >= MAX_DOWNLOAD_REDIRECTS) {
      throw new AppError('COMMAND_FAILED', 'Limrun download answered with a refused redirect', {
        reason: LIMRUN_DOWNLOAD_REASONS.redirectRefused.reason,
        statusCode: response.status,
      });
    }
    if (target.origin !== url.origin) headers = {};
    url = assertSecureCredentialTransport(target, 'Limrun download URL');
  }
}

function isFollowedRedirect(from: URL, to: URL): boolean {
  if (to.username || to.password) return false;
  return (from.protocol === 'https:' && to.protocol === 'https:') || to.origin === from.origin;
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
