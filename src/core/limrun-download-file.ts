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
// The limit `fetch` applies to the redirects it follows itself.
const MAX_DOWNLOAD_REDIRECTS = 20;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

// Why a Limrun file download did not land. A started download removes its destination on every
// failure, so each row means "retry from the same URL", and `limrun_download_failed` adds that the
// transport itself broke.
const LIMRUN_DOWNLOAD_REASONS = {
  // The service answered with an error status or a redirect that is not followed. `details.statusCode` carries it; `details.body` carries an error reply, never a redirect's.
  httpError: { reason: 'limrun_download_http_error' },
  // The download passed its deadline; `details.timeoutMs` is that deadline.
  timeout: { reason: 'limrun_download_timeout' },
  // The transfer broke for a reason the service never answered with, kept in `details.cause`.
  failed: { reason: 'limrun_download_failed' },
} as const satisfies ReasonTable<'limrun'>;

/**
 * Streams one authenticated Limrun download to disk. The transfer is bounded by `timeoutMs`; a
 * failed or timed-out attempt leaves no file at the destination, so the caller can retry from the
 * same URL and never mistakes an earlier attempt's file for this one's. A URL that may not carry a
 * credential is refused before any attempt, and the destination stays as it was.
 */
export async function downloadLimrunFile(options: LimrunFileDownload): Promise<void> {
  const url = assertSecureCredentialTransport(options.url, 'Limrun download URL');
  const timeout = AbortSignal.timeout(options.timeoutMs);
  const signal = options.signal ? AbortSignal.any([timeout, options.signal]) : timeout;
  try {
    await fs.promises.mkdir(path.dirname(options.destinationPath), { recursive: true });
    // The URL comes from the provider and can be signed, and the headers carry its bearer token.
    const response = await fetchDownload(url, options.headers, signal);
    if (response.status >= 300 && response.status < 400) throw await unfollowedRedirect(response);
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
 * Follows redirects here because `fetch` would also follow https to plain http, sending a signed
 * target in cleartext. A redirect is followed on the same origin, or from https to https without the
 * caller's headers. Any other is returned as the answer.
 */
async function fetchDownload(
  url: URL,
  headers: LimrunFileDownload['headers'],
  signal: AbortSignal,
): Promise<Response> {
  let target = url;
  let sent: LimrunFileDownload['headers'] | undefined = headers;
  for (let followed = 0; ; followed += 1) {
    const response = await fetch(target, { headers: sent, signal, redirect: 'manual' });
    const next = followed < MAX_DOWNLOAD_REDIRECTS ? redirectTarget(response, target) : undefined;
    if (!next) return response;
    await response.body?.cancel().catch(() => undefined);
    if (next.origin !== target.origin) sent = undefined;
    target = next;
  }
}

function redirectTarget(response: Response, from: URL): URL | undefined {
  const location = response.headers.get('location');
  if (!REDIRECT_STATUSES.has(response.status) || location === null) return undefined;
  const to = URL.parse(location, from);
  // `fetch` rejects a URL with userinfo with an error that quotes it.
  if (!to || to.username || to.password) return undefined;
  const staysOnHttps = from.protocol === 'https:' && to.protocol === 'https:';
  return to.origin === from.origin || staysOnHttps ? to : undefined;
}

/** Keeps no URL, `Location` or body: each can hold the download's signature or echo its token. */
async function unfollowedRedirect(response: Response): Promise<AppError> {
  await response.body?.cancel().catch(() => undefined);
  return new AppError('COMMAND_FAILED', 'Limrun download did not follow a redirect', {
    statusCode: response.status,
    reason: LIMRUN_DOWNLOAD_REASONS.httpError.reason,
  });
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
