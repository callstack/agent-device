import { createWriteStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { AppError } from '@agent-device/kernel/errors';
import {
  MAX_ARTIFACT_COMPRESSED_BYTES,
  createByteLimitStream,
} from '@agent-device/host-kit/archive';
import type { TransferPhaseWatchdog } from '@agent-device/host-kit/transport';

import { approveDownloadSourceUrl } from './install-source-network.ts';
import * as networkTransport from './install-source-network-transport.ts';

/**
 * The transfer phase tools one download uses, loaded on demand: this module sits in the CLI's
 * eager import closure, and the transport owner must stay behind a function-scoped edge
 * (ADR 0027).
 */
type TransferPhaseTools = {
  watchdog: TransferPhaseWatchdog;
  connectTimeoutMs: number;
  responseHeaderTimeoutMs: number;
  bodyInactivityTimeoutMs: number;
  isPhaseTimeout(error: unknown): boolean;
};

async function loadTransferPhaseTools(aggregateSignal: AbortSignal): Promise<TransferPhaseTools> {
  const {
    createTransferPhaseWatchdog,
    isTransferPhaseTimeoutError,
    TRANSFER_BODY_INACTIVITY_TIMEOUT_MS,
    TRANSFER_CONNECT_TIMEOUT_MS,
    TRANSFER_RESPONSE_HEADER_TIMEOUT_MS,
  } = await import('@agent-device/host-kit/transport');
  return {
    watchdog: createTransferPhaseWatchdog(aggregateSignal),
    connectTimeoutMs: TRANSFER_CONNECT_TIMEOUT_MS,
    responseHeaderTimeoutMs: TRANSFER_RESPONSE_HEADER_TIMEOUT_MS,
    bodyInactivityTimeoutMs: TRANSFER_BODY_INACTIVITY_TIMEOUT_MS,
    isPhaseTimeout: isTransferPhaseTimeoutError,
  };
}

const MAX_REDIRECTS = 5;
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

export async function downloadInstallSource(params: {
  tempDir: string;
  url: string;
  headers?: Record<string, string>;
  signal: AbortSignal;
  environment: NodeJS.ProcessEnv;
}): Promise<string> {
  // One watchdog owns the whole download: each redirect hop rearms a fresh phase timer, but the
  // aggregate is the caller's materialization signal and never restarts (#4441).
  const phases = await loadTransferPhaseTools(params.signal);
  const { watchdog } = phases;
  try {
    let currentUrl = parseSourceUrl(params.url);
    let headers = withDefaultUserAgent(sanitizeHeaders(params.headers));
    for (let redirectCount = 0; ; redirectCount += 1) {
      watchdog.arm('connect', phases.connectTimeoutMs);
      const response = await requestHop(currentUrl, headers, phases, params.environment);
      try {
        const redirected = readRedirect(response, currentUrl, redirectCount);
        if (redirected) {
          if (redirected.origin !== currentUrl.origin) headers = crossOriginHeaders(headers);
          currentUrl = redirected;
          continue;
        }
        assertSuccessfulResponse(response);
        watchdog.arm('response-body', phases.bodyInactivityTimeoutMs);
        return await writeResponse(params.tempDir, currentUrl, response, phases);
      } finally {
        await response.close();
      }
    }
  } finally {
    watchdog.dispose();
  }
}

async function requestHop(
  url: URL,
  headers: Record<string, string>,
  phases: TransferPhaseTools,
  environment: NodeJS.ProcessEnv,
): Promise<networkTransport.InstallSourceNetworkResponse> {
  const { watchdog } = phases;
  const approved = await approveDownloadSourceUrl(url, watchdog.signal);
  try {
    return await networkTransport.requestApprovedUrl({
      url,
      approvedAddress: approved.address,
      family: approved.family,
      headers: { ...headers, 'accept-encoding': 'identity' },
      signal: watchdog.signal,
      environment,
      // A bodyless download's header wait follows connection establishment.
      onConnected: () => watchdog.arm('response-headers', phases.responseHeaderTimeoutMs),
    });
  } catch (error) {
    if (error instanceof AppError) throw error;
    if (phases.isPhaseTimeout(watchdog.signal.reason)) throw watchdog.signal.reason;
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
  phases: TransferPhaseTools,
): Promise<string> {
  const { watchdog } = phases;
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
  // Accepted body bytes are the only progress that rearms the inactivity ceiling. The pipeline
  // signal aborts and joins the owned streams on cancellation, phase timeout or aggregate expiry.
  const progress = new Transform({
    transform(chunk, _encoding, callback) {
      watchdog.touchBody();
      callback(null, chunk);
    },
  });
  try {
    await pipeline(
      response.body,
      progress,
      byteLimit,
      createWriteStream(destinationPath, {
        flags: 'wx',
      }),
      { signal: watchdog.signal },
    );
    return destinationPath;
  } catch (error) {
    await fs.rm(destinationPath, { force: true }).catch(() => {});
    if (phases.isPhaseTimeout(error)) throw error;
    if (phases.isPhaseTimeout(watchdog.signal.reason)) throw watchdog.signal.reason;
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
