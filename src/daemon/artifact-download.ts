import fs from 'node:fs';
import http, { type IncomingMessage } from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { AppError } from '../kernel/errors.ts';

const MAX_ARTIFACT_BYTES = 2 * 1024 * 1024 * 1024; // 2 GB
const MAX_ERROR_BODY_CHARS = 4096;
const TEMP_PREFIX = 'agent-device-artifact-';
const REQUEST_IDLE_TIMEOUT_MS = 60_000;
const MAX_REDIRECTS = 5;

export function sanitizeArtifactFilename(raw: string): string {
  const trimmed = raw.trim();
  const basename = path.basename(trimmed);
  if (!basename || basename === '.' || basename === '..') {
    throw new AppError('INVALID_ARGS', `Invalid artifact filename: ${raw}`);
  }
  return basename;
}

export function createArtifactTempDir(requestId?: string): string {
  const scope = sanitizeRequestId(requestId);
  return fs.mkdtempSync(path.join(os.tmpdir(), `${TEMP_PREFIX}${scope}-`));
}

export function validateArtifactContentLength(rawLength: string | number | undefined): void {
  if (rawLength === undefined) return;
  const parsed = Number(rawLength);
  // Ignore malformed content-length values; the streaming byte cap still enforces the hard limit.
  if (Number.isFinite(parsed) && parsed > MAX_ARTIFACT_BYTES) {
    throw new AppError(
      'INVALID_ARGS',
      `Upload exceeds maximum size of ${MAX_ARTIFACT_BYTES} bytes`,
    );
  }
}

export function streamReadableToFile(
  source: NodeJS.ReadableStream,
  destPath: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let bytesWritten = 0;
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const output = fs.createWriteStream(destPath);

    const settle = (error?: unknown) => {
      if (settled) return;
      settled = true;
      if (timeoutHandle) clearTimeout(timeoutHandle);
      if (error) {
        void removePartialFile(output, destPath).finally(() => reject(error));
        return;
      }
      resolve();
    };
    const armTimeout = () => {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      timeoutHandle = setTimeout(() => {
        const error = new AppError(
          'COMMAND_FAILED',
          'Artifact transfer timed out due to inactivity',
          {
            timeoutMs: REQUEST_IDLE_TIMEOUT_MS,
          },
        );
        if ('destroy' in source && typeof source.destroy === 'function') {
          source.destroy(error);
        }
        byteLimit.destroy(error);
        settle(error);
      }, REQUEST_IDLE_TIMEOUT_MS);
    };

    const byteLimit = new Transform({
      transform(chunk: Buffer | string, encoding, callback) {
        armTimeout();
        const size = Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk, encoding);
        bytesWritten += size;
        if (bytesWritten > MAX_ARTIFACT_BYTES) {
          callback(
            new AppError(
              'INVALID_ARGS',
              `Upload exceeds maximum size of ${MAX_ARTIFACT_BYTES} bytes`,
            ),
          );
          return;
        }
        callback(null, chunk);
      },
    });

    source.on('aborted', () => {
      settle(new AppError('COMMAND_FAILED', 'Artifact transfer was interrupted'));
    });
    armTimeout();
    void pipeline(source, byteLimit, output).then(
      () => settle(),
      (error: unknown) => settle(error),
    );
  });
}

async function removePartialFile(output: fs.WriteStream, destPath: string): Promise<void> {
  output.destroy();
  if (!output.closed) {
    try {
      await once(output, 'close');
    } catch {
      // best-effort cleanup only
    }
  }
  await fs.promises.rm(destPath, { force: true }).catch(() => {});
}

export async function downloadArtifactToTempDir(params: {
  url: string;
  headers?: Record<string, string>;
  requestId?: string;
  tempDir: string;
}): Promise<{ archivePath: string }> {
  const final = await requestArtifact(new URL(params.url), params.headers, params.requestId, 0);
  const filename = resolveInitialArtifactFilename({
    contentDisposition: final.response.headers['content-disposition'],
    url: final.url,
  });
  const archivePath = path.join(params.tempDir, filename);
  validateArtifactContentLength(final.response.headers['content-length']);

  try {
    await streamReadableToFile(final.response, archivePath);
    return { archivePath };
  } catch (error) {
    final.response.destroy();
    throw error;
  }
}

function sanitizeRequestId(raw: string | undefined): string {
  const trimmed = raw?.trim();
  if (!trimmed) return 'request';
  const normalized = trimmed.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return normalized.length > 0 ? normalized.slice(0, 48) : 'request';
}

async function requestArtifact(
  url: URL,
  headers: Record<string, string> | undefined,
  requestId: string | undefined,
  redirectCount: number,
): Promise<{ response: IncomingMessage; url: URL }> {
  if (redirectCount > MAX_REDIRECTS) {
    throw new AppError('COMMAND_FAILED', 'Artifact download exceeded redirect limit', {
      requestId,
      url: url.toString(),
      maxRedirects: MAX_REDIRECTS,
    });
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new AppError('INVALID_ARGS', `Unsupported artifact URL protocol: ${url.protocol}`);
  }

  const transport = url.protocol === 'https:' ? https : http;
  return await new Promise((resolve, reject) => {
    let settled = false;
    const settle = (error?: Error, response?: IncomingMessage, finalUrl?: URL) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutHandle);
      if (error) {
        reject(error);
        return;
      }
      if (!response || !finalUrl) {
        reject(
          new AppError('COMMAND_FAILED', 'Artifact download failed without a response', {
            requestId,
            url: url.toString(),
          }),
        );
        return;
      }
      resolve({ response, url: finalUrl });
    };

    const request = transport.request(
      {
        protocol: url.protocol,
        host: url.hostname,
        port: url.port,
        method: 'GET',
        path: url.pathname + url.search,
        headers,
      },
      async (response) => {
        const statusCode = response.statusCode ?? 500;
        const location = response.headers.location;
        if (location && [301, 302, 303, 307, 308].includes(statusCode)) {
          response.resume();
          try {
            const redirectedUrl = new URL(location, url);
            const redirectedHeaders = resolveRedirectHeaders(
              url,
              redirectedUrl,
              headers,
              requestId,
            );
            const redirected = await requestArtifact(
              redirectedUrl,
              redirectedHeaders,
              requestId,
              redirectCount + 1,
            );
            settle(undefined, redirected.response, redirected.url);
          } catch (error) {
            settle(error instanceof Error ? error : new Error(String(error)));
          }
          return;
        }

        if (statusCode >= 400) {
          let body = '';
          response.setEncoding('utf8');
          response.on('data', (chunk) => {
            if (body.length >= MAX_ERROR_BODY_CHARS) return;
            const remaining = MAX_ERROR_BODY_CHARS - body.length;
            body += chunk.slice(0, remaining);
          });
          response.on('end', () => {
            settle(
              new AppError('COMMAND_FAILED', 'Failed to download artifact', {
                requestId,
                url: url.toString(),
                statusCode,
                body: body.length === MAX_ERROR_BODY_CHARS ? `${body}...<truncated>` : body,
              }),
            );
          });
          return;
        }

        settle(undefined, response, url);
      },
    );

    const timeoutHandle = setTimeout(() => {
      request.destroy(
        new AppError('COMMAND_FAILED', 'Artifact request timed out waiting for response', {
          requestId,
          url: url.toString(),
          timeoutMs: REQUEST_IDLE_TIMEOUT_MS,
        }),
      );
    }, REQUEST_IDLE_TIMEOUT_MS);

    request.on('error', (error) => {
      if (error instanceof AppError) {
        settle(error);
        return;
      }
      settle(
        new AppError(
          'COMMAND_FAILED',
          'Failed to download artifact',
          {
            requestId,
            url: url.toString(),
            timeoutMs: REQUEST_IDLE_TIMEOUT_MS,
          },
          error instanceof Error ? error : undefined,
        ),
      );
    });
    request.end();
  });
}

function resolveRedirectHeaders(
  currentUrl: URL,
  redirectedUrl: URL,
  headers: Record<string, string> | undefined,
  requestId: string | undefined,
): Record<string, string> | undefined {
  if (!headers || Object.keys(headers).length === 0) return headers;
  if (currentUrl.origin === redirectedUrl.origin) return headers;
  throw new AppError(
    'COMMAND_FAILED',
    'Artifact download redirect changed origin while custom headers were provided',
    {
      requestId,
      from: currentUrl.toString(),
      to: redirectedUrl.toString(),
    },
  );
}

function resolveInitialArtifactFilename(params: {
  contentDisposition: string | string[] | undefined;
  url: URL;
}): string {
  const contentDisposition = Array.isArray(params.contentDisposition)
    ? params.contentDisposition[0]
    : params.contentDisposition;

  const fromDisposition = parseContentDispositionFilename(contentDisposition);
  if (fromDisposition) return sanitizeArtifactFilename(fromDisposition);

  const pathname = decodeURIComponentSafe(params.url.pathname);
  const fromPath = path.basename(pathname);
  if (fromPath && fromPath !== '/' && fromPath !== '.') {
    return sanitizeArtifactFilename(fromPath);
  }

  return 'artifact';
}

function parseContentDispositionFilename(header: string | undefined): string | undefined {
  if (!header) return undefined;

  const encodedMatch = header.match(/filename\*\s*=\s*([^;]+)/i);
  if (encodedMatch) {
    const rawValue = encodedMatch[1]
      ?.trim()
      .replace(/^UTF-8''/i, '')
      .replace(/^"(.*)"$/, '$1');
    const decoded = decodeURIComponentSafe(rawValue ?? '');
    if (decoded) return decoded;
  }

  const plainMatch = header.match(/filename\s*=\s*([^;]+)/i);
  if (!plainMatch) return undefined;
  const rawValue = plainMatch[1]?.trim().replace(/^"(.*)"$/, '$1');
  return rawValue || undefined;
}

function decodeURIComponentSafe(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
