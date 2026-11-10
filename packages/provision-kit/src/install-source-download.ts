import { createWriteStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { AppError } from '@agent-device/kernel/errors';
import {
  MAX_ARTIFACT_COMPRESSED_BYTES,
  createByteLimitStream,
} from '@agent-device/host-kit/archive';

import { approveDownloadSourceUrl } from './install-source-network.ts';
import * as networkTransport from './install-source-network-transport.ts';

const MAX_REDIRECTS = 5;
/**
 * How long a download may go without progress: no response headers, or no body bytes. The whole
 * transfer has no bound of its own; the request's envelope, through `signal`, bounds it.
 */
const SOURCE_DOWNLOAD_STALL_TIMEOUT_MS = 120_000;
const DEFAULT_USER_AGENT = 'agent-device';
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const NETWORK_ERROR_CODE_RE = /^[A-Z][A-Z0-9_]{0,63}$/;
const FORBIDDEN_HEADERS = new Set([
  'accept-encoding',
  'connection',
  'content-length',
  'host',
  'keep-alive',
  'proxy-connection',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

/**
 * Downloads an install source into `tempDir`. A download that makes no progress for the stall
 * window fails with a timeout; an aborted `signal` rejects with the abort's own error.
 */
export async function downloadInstallSource(params: {
  tempDir: string;
  url: string;
  headers?: Record<string, string>;
  signal: AbortSignal;
  environment: NodeJS.ProcessEnv;
}): Promise<string> {
  let currentUrl = parseSourceUrl(params.url);
  let headers = withDefaultUserAgent(sanitizeHeaders(params.headers));
  const stall = createStallGuard(params.signal);
  try {
    for (let redirectCount = 0; ; redirectCount += 1) {
      const response = await requestHop(currentUrl, headers, stall.signal, params.environment);
      try {
        const redirected = readRedirect(response, currentUrl, redirectCount);
        if (redirected) {
          if (redirected.origin !== currentUrl.origin) headers = crossOriginHeaders(headers);
          currentUrl = redirected;
          stall.progress();
          continue;
        }
        assertSuccessfulResponse(response);
        return await writeResponse(params.tempDir, currentUrl, response, stall);
      } finally {
        await response.close();
      }
    }
  } catch (error) {
    if (!stall.stalled() || params.signal.aborted) throw error;
    throw new AppError(
      'COMMAND_FAILED',
      `App source download made no progress for ${SOURCE_DOWNLOAD_STALL_TIMEOUT_MS}ms`,
      { timeoutMs: SOURCE_DOWNLOAD_STALL_TIMEOUT_MS },
      error,
    );
  } finally {
    stall.dispose();
  }
}

type StallGuard = {
  /** Aborts when the caller aborts or the download stalls. */
  signal: AbortSignal;
  progress(): void;
  stalled(): boolean;
  dispose(): void;
};

function createStallGuard(outer: AbortSignal): StallGuard {
  const controller = new AbortController();
  let stalled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const onOuterAbort = () => controller.abort(outer.reason);
  outer.addEventListener('abort', onOuterAbort, { once: true });
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      stalled = true;
      controller.abort();
    }, SOURCE_DOWNLOAD_STALL_TIMEOUT_MS);
  };
  arm();
  return {
    signal: controller.signal,
    progress: arm,
    stalled: () => stalled,
    dispose: () => {
      clearTimeout(timer);
      outer.removeEventListener('abort', onOuterAbort);
    },
  };
}

async function requestHop(
  url: URL,
  headers: Record<string, string>,
  signal: AbortSignal,
  environment: NodeJS.ProcessEnv,
): Promise<networkTransport.InstallSourceNetworkResponse> {
  const approved = await approveDownloadSourceUrl(url, signal);
  try {
    return await networkTransport.requestApprovedUrl({
      url,
      approvedAddress: approved.address,
      family: approved.family,
      headers: { ...headers, 'accept-encoding': 'identity' },
      signal,
      environment,
    });
  } catch (error) {
    if (error instanceof AppError) throw error;
    const networkErrorCode = readNetworkErrorCode(error);
    throw new AppError(
      'COMMAND_FAILED',
      networkErrorCode
        ? `The daemon failed to fetch the app source (network error code: ${networkErrorCode})`
        : 'The daemon failed to fetch the app source',
      networkErrorCode ? { networkErrorCode } : undefined,
      error,
    );
  }
}

// Only the code crosses to the caller: a remote daemon's cause message can name
// its resolved addresses, proxy, or server-supplied certificate names.
function readNetworkErrorCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && NETWORK_ERROR_CODE_RE.test(code) ? code : undefined;
}

function readRedirect(
  response: networkTransport.InstallSourceNetworkResponse,
  currentUrl: URL,
  redirectCount: number,
): URL | undefined {
  if (!REDIRECT_STATUSES.has(response.statusCode)) return undefined;
  response.body.resume?.();
  const location = readHeader(response.headers, 'location');
  if (!location || redirectCount >= MAX_REDIRECTS) {
    throw new AppError('COMMAND_FAILED', 'App source redirect limit was exceeded', {
      status: response.statusCode,
    });
  }
  const redirected = new URL(location, currentUrl);
  if (currentUrl.protocol === 'https:' && redirected.protocol !== 'https:') {
    throw new AppError('COMMAND_FAILED', 'App source redirect downgraded HTTPS');
  }
  return redirected;
}

function assertSuccessfulResponse(response: networkTransport.InstallSourceNetworkResponse): void {
  if (response.statusCode >= 200 && response.statusCode < 300) return;
  throw new AppError('COMMAND_FAILED', `Failed to download app source: ${response.statusCode}`, {
    status: response.statusCode,
  });
}

async function writeResponse(
  tempDir: string,
  url: URL,
  response: networkTransport.InstallSourceNetworkResponse,
  stall: StallGuard,
): Promise<string> {
  const encoding = readHeader(response.headers, 'content-encoding');
  if (encoding && encoding.toLowerCase() !== 'identity') {
    throw new AppError('COMMAND_FAILED', 'App source response used unsupported content encoding');
  }
  validateContentLength(readHeader(response.headers, 'content-length'));
  const destinationPath = path.join(tempDir, resolveDownloadFileName(response, url));
  const byteLimit = createByteLimitStream({
    maxBytes: MAX_ARTIFACT_COMPRESSED_BYTES,
    createLimitError: () =>
      new AppError(
        'COMMAND_FAILED',
        `App source exceeds maximum size of ${MAX_ARTIFACT_COMPRESSED_BYTES} bytes`,
        { reason: 'ARTIFACT_BYTE_LIMIT' },
      ),
  });
  try {
    const progress = new Transform({
      transform(chunk, _encoding, callback) {
        stall.progress();
        callback(null, chunk);
      },
    });
    await pipeline(
      response.body,
      progress,
      byteLimit,
      createWriteStream(destinationPath, { flags: 'wx' }),
      { signal: stall.signal },
    );
    return destinationPath;
  } catch (error) {
    await fs.rm(destinationPath, { force: true }).catch(() => {});
    throw error;
  }
}

function validateContentLength(raw: string | null): void {
  if (raw === null) return;
  if (!/^\d+$/.test(raw)) {
    throw new AppError('COMMAND_FAILED', 'App source response had invalid content-length');
  }
  const length = Number(raw);
  if (!Number.isSafeInteger(length) || length > MAX_ARTIFACT_COMPRESSED_BYTES) {
    throw new AppError('COMMAND_FAILED', 'App source response exceeded the byte limit', {
      reason: 'ARTIFACT_BYTE_LIMIT',
    });
  }
}

function sanitizeHeaders(input: Record<string, string> | undefined): Record<string, string> {
  const connectionTokens = new Set(
    Object.entries(input ?? {})
      .filter(([name]) => name.toLowerCase() === 'connection')
      .flatMap(([, value]) => value.split(',').map((token) => token.trim().toLowerCase())),
  );
  return Object.fromEntries(
    Object.entries(input ?? {}).filter(([name]) => {
      const lower = name.toLowerCase();
      return !FORBIDDEN_HEADERS.has(lower) && !connectionTokens.has(lower);
    }),
  );
}

function withDefaultUserAgent(headers: Record<string, string>): Record<string, string> {
  if (Object.keys(headers).some((name) => name.toLowerCase() === 'user-agent')) return headers;
  return { ...headers, 'user-agent': DEFAULT_USER_AGENT };
}

function crossOriginHeaders(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).filter(([name]) =>
      ['accept', 'user-agent'].includes(name.toLowerCase()),
    ),
  );
}

function resolveDownloadFileName(
  response: networkTransport.InstallSourceNetworkResponse,
  parsedUrl: URL,
): string {
  const disposition = readHeader(response.headers, 'content-disposition');
  const match = disposition?.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i);
  const candidate =
    match?.[1]?.trim() || path.basename(parsedUrl.pathname) || 'downloaded-artifact.bin';
  return path.basename(candidate);
}

function readHeader(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | null {
  const value = headers[name];
  return Array.isArray(value) ? (value[0] ?? null) : (value ?? null);
}

function parseSourceUrl(raw: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw invalidSourceUrlError();
  }

  if (parsed.username || parsed.password) {
    throw new AppError('INVALID_ARGS', 'Source URL credentials are not allowed');
  }
  return parsed;
}

export function invalidSourceUrlError(): AppError {
  return new AppError('INVALID_ARGS', 'Invalid source URL');
}
