import { createWriteStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { AppError } from '@agent-device/kernel/errors';
import { MAX_ARTIFACT_COMPRESSED_BYTES } from '../utils/artifact-limits.ts';
import { createByteLimitStream } from '../utils/byte-limit-stream.ts';
import { approveDownloadSourceUrl } from './install-source-network.ts';
import * as networkTransport from './install-source-network-transport.ts';

const MAX_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
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
}): Promise<string> {
  let currentUrl = parseSourceUrl(params.url);
  let headers = sanitizeHeaders(params.headers);
  for (let redirectCount = 0; ; redirectCount += 1) {
    const response = await requestHop(currentUrl, headers, params.signal);
    try {
      const redirected = readRedirect(response, currentUrl, redirectCount);
      if (redirected) {
        if (redirected.origin !== currentUrl.origin) headers = crossOriginHeaders(headers);
        currentUrl = redirected;
        continue;
      }
      assertSuccessfulResponse(response);
      return await writeResponse(params.tempDir, currentUrl, response);
    } finally {
      await response.close();
    }
  }
}

async function requestHop(
  url: URL,
  headers: Record<string, string>,
  signal: AbortSignal,
): Promise<networkTransport.InstallSourceNetworkResponse> {
  const approved = await approveDownloadSourceUrl(url, signal);
  try {
    return await networkTransport.requestApprovedUrl({
      url,
      approvedAddress: approved.address,
      family: approved.family,
      headers: { ...headers, 'accept-encoding': 'identity' },
      signal,
    });
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError('COMMAND_FAILED', 'App source network request failed', undefined, error);
  }
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
    await pipeline(response.body, byteLimit, createWriteStream(destinationPath, { flags: 'wx' }));
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
  try {
    const parsed = new URL(raw);
    if (parsed.username || parsed.password) {
      throw new AppError('INVALID_ARGS', 'Source URL credentials are not allowed');
    }
    return parsed;
  } catch {
    throw new AppError('INVALID_ARGS', 'Invalid source URL');
  }
}
