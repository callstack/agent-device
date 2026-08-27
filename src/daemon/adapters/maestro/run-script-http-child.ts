import { AppError } from '@agent-device/kernel/errors';
import { pathToFileURL } from 'node:url';
import type { DaemonNetworkAccessPolicy } from '../../types.ts';
import {
  requestApprovedUrl,
  type InstallSourceNetworkResponse,
} from '@agent-device/provision-kit/install-source-network-transport';
import { approvePublicNetworkUrl } from '@agent-device/provision-kit/install-source-network';

const MAX_REDIRECTS = 5;
export const MAX_RUN_SCRIPT_HTTP_RESPONSE_BYTES = 8 * 1024 * 1024;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const REDIRECT_TO_GET_STATUSES = new Set([301, 302, 303]);
const CROSS_ORIGIN_HEADERS = new Set(['accept', 'user-agent']);

export type RunScriptHttpRequest = {
  method: 'GET' | 'POST';
  url: string;
  headers: Record<string, string>;
  body?: string;
  networkAccess: DaemonNetworkAccessPolicy;
};

export type RunScriptHttpResponse = {
  status: number;
  body: string;
  headers: Record<string, string>;
};

type PublicRequestState = {
  url: URL;
  headers: Record<string, string>;
  method: 'GET' | 'POST';
  body?: string;
};

type PublicResponseOutcome =
  | { response: RunScriptHttpResponse }
  | { nextRequest: PublicRequestState };

export async function executeRunScriptHttpRequest(
  input: RunScriptHttpRequest,
): Promise<RunScriptHttpResponse> {
  if (input.networkAccess === 'public-only') return await executePublicRequest(input);
  return await executeUnrestrictedRequest(input);
}

async function executeUnrestrictedRequest(
  input: RunScriptHttpRequest,
): Promise<RunScriptHttpResponse> {
  if (typeof fetch !== 'function') {
    throw new Error('global fetch is required for Maestro runScript http helpers');
  }
  const response = await fetch(input.url, {
    method: input.method,
    headers: input.headers,
    ...(input.body !== undefined ? { body: input.body } : {}),
  });
  return {
    status: response.status,
    body: await response.text(),
    headers: Object.fromEntries(response.headers.entries()),
  };
}

async function executePublicRequest(input: RunScriptHttpRequest): Promise<RunScriptHttpResponse> {
  let request = createPublicRequest(input);
  const signal = AbortSignal.timeout(30_000);

  for (let redirectCount = 0; ; redirectCount += 1) {
    const response = await requestPublicHop(request, signal);
    try {
      const outcome = await processPublicResponse(response, request, redirectCount);
      if ('response' in outcome) return outcome.response;
      request = outcome.nextRequest;
    } finally {
      await response.close();
    }
  }
}

function createPublicRequest(input: RunScriptHttpRequest): PublicRequestState {
  try {
    return {
      url: new URL(input.url),
      headers: { ...input.headers },
      method: input.method,
      ...(input.body !== undefined ? { body: input.body } : {}),
    };
  } catch {
    throw new AppError('INVALID_ARGS', 'Invalid Maestro runScript HTTP URL');
  }
}

async function requestPublicHop(
  request: PublicRequestState,
  signal: AbortSignal,
): Promise<InstallSourceNetworkResponse> {
  const approved = await approvePublicNetworkUrl(request.url, {
    signal,
    label: 'Maestro runScript URL',
    hint: 'Use a public URL.',
  });
  return await requestApprovedUrl({
    url: request.url,
    approvedAddress: approved.address,
    family: approved.family,
    headers: request.headers,
    signal,
    method: request.method,
    ...(request.body !== undefined ? { body: request.body } : {}),
  });
}

async function processPublicResponse(
  response: InstallSourceNetworkResponse,
  request: PublicRequestState,
  redirectCount: number,
): Promise<PublicResponseOutcome> {
  if (REDIRECT_STATUSES.has(response.statusCode)) {
    response.body.resume?.();
    return { nextRequest: createRedirectRequest(response, request, redirectCount) };
  }
  const responseBody = await readResponseBody(response);
  return {
    response: {
      status: response.statusCode,
      body: responseBody,
      headers: responseHeadersToRecord(response.headers),
    },
  };
}

function createRedirectRequest(
  response: InstallSourceNetworkResponse,
  request: PublicRequestState,
  redirectCount: number,
): PublicRequestState {
  const location = readHeader(response.headers, 'location');
  if (!location || redirectCount >= MAX_REDIRECTS) {
    throw new AppError('COMMAND_FAILED', 'Maestro runScript HTTP redirect limit was exceeded', {
      status: response.statusCode,
    });
  }
  const redirected = new URL(location, request.url);
  if (request.url.protocol === 'https:' && redirected.protocol !== 'https:') {
    throw new AppError('COMMAND_FAILED', 'Maestro runScript HTTP redirect downgraded HTTPS');
  }
  return {
    url: redirected,
    headers:
      redirected.origin === request.url.origin
        ? request.headers
        : crossOriginHeaders(request.headers),
    ...redirectMethod(response.statusCode, request.method, request.body),
  };
}

function redirectMethod(
  statusCode: number,
  method: 'GET' | 'POST',
  body: string | undefined,
): { method: 'GET' | 'POST'; body?: string } {
  if (method === 'GET' || !REDIRECT_TO_GET_STATUSES.has(statusCode)) return { method, body };
  return { method: 'GET' };
}

async function readResponseBody(response: InstallSourceNetworkResponse): Promise<string> {
  const chunks: Buffer[] = [];
  let bytesSeen = 0;
  for await (const chunk of response.body as AsyncIterable<Buffer | string>) {
    const chunkBytes = typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.byteLength;
    const nextBytesSeen = bytesSeen + chunkBytes;
    if (nextBytesSeen > MAX_RUN_SCRIPT_HTTP_RESPONSE_BYTES) {
      throw new AppError(
        'COMMAND_FAILED',
        `Maestro runScript HTTP response exceeded ${MAX_RUN_SCRIPT_HTTP_RESPONSE_BYTES} bytes`,
        { limitBytes: MAX_RUN_SCRIPT_HTTP_RESPONSE_BYTES, status: response.statusCode },
      );
    }
    bytesSeen = nextBytesSeen;
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk));
  }
  return Buffer.concat(chunks, bytesSeen).toString('utf8');
}

function responseHeadersToRecord(
  headers: InstallSourceNetworkResponse['headers'],
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [
      key,
      Array.isArray(value) ? value.join(', ') : (value ?? ''),
    ]),
  );
}

function readHeader(
  headers: InstallSourceNetworkResponse['headers'],
  name: string,
): string | undefined {
  const lowerName = name.toLowerCase();
  const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === lowerName)?.[1];
  return Array.isArray(entry) ? entry[0] : entry;
}

function crossOriginHeaders(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).filter(([name]) => CROSS_ORIGIN_HEADERS.has(name.toLowerCase())),
  );
}

async function readInput(): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}

function parseInput(value: unknown): RunScriptHttpRequest {
  const record = parseInputRecord(value);
  return {
    method: parseMethod(record.method),
    url: parseInputUrl(record.url),
    headers: parseHeaders(record.headers),
    ...parseBody(record.body),
    networkAccess: parseNetworkAccess(record.networkAccess),
  };
}

function parseInputRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object') throw new Error('invalid Maestro runScript HTTP input');
  return value as Record<string, unknown>;
}

function parseMethod(value: unknown): 'GET' | 'POST' {
  if (value !== 'GET' && value !== 'POST') {
    throw new Error('invalid Maestro runScript HTTP method');
  }
  return value;
}

function parseInputUrl(value: unknown): string {
  if (typeof value !== 'string') throw new Error('invalid Maestro runScript HTTP input');
  return value;
}

function parseHeaders(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('invalid Maestro runScript HTTP headers');
  }
  const headers: Record<string, string> = {};
  for (const [key, headerValue] of Object.entries(value as Record<string, unknown>)) {
    if (typeof headerValue !== 'string') throw new Error('invalid Maestro runScript HTTP headers');
    headers[key] = headerValue;
  }
  return headers;
}

function parseBody(value: unknown): { body?: string } {
  if (value === undefined) return {};
  if (typeof value !== 'string') throw new Error('invalid Maestro runScript HTTP body');
  return { body: value };
}

function parseNetworkAccess(value: unknown): DaemonNetworkAccessPolicy {
  if (typeof value !== 'string') throw new Error('invalid Maestro runScript HTTP input');
  if (value !== 'unrestricted' && value !== 'public-only') {
    throw new Error('invalid Maestro runScript HTTP network policy');
  }
  return value;
}

async function runChild(): Promise<void> {
  const response = await executeRunScriptHttpRequest(parseInput(await readInput()));
  process.stdout.write(JSON.stringify(response));
}

const isDirectRun = process.argv[1]
  ? pathToFileURL(process.argv[1]).href === import.meta.url
  : false;
if (isDirectRun) {
  void runChild().catch((error: unknown) => {
    console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
    process.exitCode = 1;
  });
}
