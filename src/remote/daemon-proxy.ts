import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { randomUUID } from 'node:crypto';
import { AppError, normalizeError } from '../kernel/errors.ts';
import { readNodeHttpRequestBody } from '../utils/node-http.ts';
import { timingSafeStringEqual } from '../utils/timing-safe-equal.ts';
import {
  DAEMON_HTTP_BASE_PATH,
  buildDaemonHttpAuthHeaders,
  buildDaemonHttpUrl,
} from '../daemon/http-contract.ts';
import { buildDaemonHealthPayload } from '../daemon/http-health.ts';

export type DaemonProxyOptions = {
  upstreamBaseUrl: string;
  upstreamToken: string;
  clientToken: string;
  maxRpcBodyBytes?: number;
  upstreamTimeoutMs?: number;
  fetchImpl?: typeof fetch;
};

const DEFAULT_MAX_RPC_BODY_BYTES = 1024 * 1024;
const DEFAULT_UPSTREAM_TIMEOUT_MS = 5 * 60 * 1000;
const DAEMON_PROXY_PREFIX = `${DAEMON_HTTP_BASE_PATH}/`;
const FORWARDED_REQUEST_HEADERS = [
  'content-type',
  'content-range',
  'x-artifact-type',
  'x-artifact-filename',
  'x-artifact-hash',
  'x-artifact-hash-algorithm',
];
const FORWARDED_RESPONSE_HEADERS = ['content-type', 'content-disposition', 'x-request-id'];

export function createDaemonProxyServer(options: DaemonProxyOptions): http.Server {
  const normalized = normalizeProxyOptions(options);
  return http.createServer((req, res) => {
    void handleProxyRequest(req, res, normalized).catch((error: unknown) => {
      sendProxyError(res, error);
    });
  });
}

async function handleProxyRequest(
  req: IncomingMessage,
  res: ServerResponse,
  options: Required<DaemonProxyOptions>,
): Promise<void> {
  const route = resolveProxyRoute(req.url ?? '/');
  if (req.method === 'GET' && route === '/health') {
    await sendProxyHealth(res, options);
    return;
  }

  if (!isSupportedDaemonRoute(route, req.method)) {
    res.statusCode = 404;
    res.end('Not found');
    return;
  }

  let rpcBody: string | undefined;
  if (route === '/rpc') {
    rpcBody = (
      await readNodeHttpRequestBody(
        req,
        options.maxRpcBodyBytes,
        'Proxy request body is too large.',
      )
    ).toString('utf8');
  }

  if (!isAuthorized(req, options.clientToken, rpcBody)) {
    sendUnauthorized(res, route, readJsonRpcId(rpcBody));
    return;
  }

  await forwardProxyRequest({ req, res, route, options, rpcBody });
}

async function sendProxyHealth(res: ServerResponse, options: Required<DaemonProxyOptions>) {
  const upstream = await readUpstreamHealth(options);
  res.statusCode = 200;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(buildDaemonHealthPayload('agent-device-proxy', { upstream })));
}

async function readUpstreamHealth(options: Required<DaemonProxyOptions>): Promise<unknown> {
  const upstreamUrl = new URL(buildDaemonHttpUrl(options.upstreamBaseUrl, 'health'));
  const response = await options.fetchImpl(upstreamUrl, {
    method: 'GET',
    headers: buildUpstreamHeaders({ headers: {} }, options.upstreamToken, '/health'),
    signal: AbortSignal.timeout(options.upstreamTimeoutMs),
  });
  const text = await response.text();
  try {
    return text ? JSON.parse(text) : { ok: response.ok, status: response.status };
  } catch {
    return { ok: response.ok, status: response.status };
  }
}

async function forwardProxyRequest(params: {
  req: IncomingMessage;
  res: ServerResponse;
  route: string;
  options: Required<DaemonProxyOptions>;
  rpcBody?: string;
}): Promise<void> {
  const { req, res, route, options, rpcBody } = params;
  const upstreamUrl = buildUpstreamUrl(options.upstreamBaseUrl, route, req.url ?? '/');
  const method = req.method ?? 'GET';
  const headers = buildUpstreamHeaders(req, options.upstreamToken, route);
  const body = resolveUpstreamBody(req, route, rpcBody, options.upstreamToken);
  const response = await options.fetchImpl(upstreamUrl, {
    method,
    headers,
    signal: AbortSignal.timeout(options.upstreamTimeoutMs),
    ...(body ? { body, duplex: 'half' as const } : {}),
  });

  await sendProxyResponse({ req, res, route, response, clientToken: options.clientToken });
}

async function sendProxyResponse(params: {
  req: IncomingMessage;
  res: ServerResponse;
  route: string;
  response: Response;
  clientToken: string;
}): Promise<void> {
  const { req, res, route, response, clientToken } = params;
  res.statusCode = response.status;
  copyProxyResponseHeaders(response, res);
  ensureProxyRequestId(req, res);

  if (isUploadPreflightRoute(route)) {
    await sendRewrittenUploadPreflightResponse({ req, res, response, clientToken });
    return;
  }

  await pipeProxyResponseBody(response, res);
}

function copyProxyResponseHeaders(response: Response, res: ServerResponse): void {
  for (const name of FORWARDED_RESPONSE_HEADERS) {
    const value = response.headers.get(name);
    if (value) res.setHeader(name, value);
  }
}

function ensureProxyRequestId(req: IncomingMessage, res: ServerResponse): void {
  if (!res.hasHeader('x-request-id')) {
    res.setHeader('x-request-id', resolveRequestId(req));
  }
}

async function sendRewrittenUploadPreflightResponse(params: {
  req: IncomingMessage;
  res: ServerResponse;
  response: Response;
  clientToken: string;
}): Promise<void> {
  const { req, res, response, clientToken } = params;
  const text = await response.text();
  res.setHeader('content-type', response.headers.get('content-type') ?? 'application/json');
  res.end(rewriteUploadPreflightResponse(text, req, clientToken));
}

function rewriteUploadPreflightResponse(
  body: string,
  req: IncomingMessage,
  clientToken: string,
): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body) as unknown;
  } catch {
    return body;
  }

  if (!parsed || typeof parsed !== 'object') return body;
  const record = parsed as { upload?: { url?: unknown; headers?: unknown } };
  if (!record.upload || typeof record.upload.url !== 'string') {
    return body;
  }

  const rewrittenUrl = rewriteUploadDirectUrl(record.upload.url, req);
  if (!rewrittenUrl) return body;

  const headers =
    record.upload.headers && typeof record.upload.headers === 'object'
      ? { ...(record.upload.headers as Record<string, unknown>) }
      : {};
  Object.assign(headers, buildDaemonHttpAuthHeaders(clientToken));

  return JSON.stringify({
    ...(parsed as Record<string, unknown>),
    upload: {
      ...record.upload,
      url: rewrittenUrl,
      headers,
    },
  });
}

function rewriteUploadDirectUrl(upstreamUrl: string, req: IncomingMessage): string | null {
  let parsed: URL;
  try {
    parsed = new URL(upstreamUrl);
  } catch {
    return null;
  }

  if (!parsed.pathname.startsWith('/upload/')) {
    return null;
  }

  const host = typeof req.headers.host === 'string' ? req.headers.host : '';
  if (!host) return null;

  const requestPath = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
  const uploadIndex = requestPath.lastIndexOf('/upload/preflight');
  const uploadPrefix = uploadIndex >= 0 ? requestPath.slice(0, uploadIndex) : '';
  const forwardedProto = req.headers['x-forwarded-proto'];
  const proto = Array.isArray(forwardedProto) ? forwardedProto[0] : forwardedProto;
  const rewritten = new URL(`${proto || 'http'}://${host}`);
  rewritten.pathname = `${uploadPrefix}${parsed.pathname}`;
  rewritten.search = parsed.search;
  return rewritten.toString();
}

async function pipeProxyResponseBody(response: Response, res: ServerResponse): Promise<void> {
  if (!response.body) {
    res.end();
    return;
  }
  await pipeline(Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]), res);
}

function normalizeProxyOptions(options: DaemonProxyOptions): Required<DaemonProxyOptions> {
  const upstreamBaseUrl = normalizeBaseUrl(options.upstreamBaseUrl, 'upstreamBaseUrl');
  const upstreamToken = normalizeToken(options.upstreamToken, 'upstreamToken');
  const clientToken = normalizeToken(options.clientToken, 'clientToken');
  return {
    upstreamBaseUrl,
    upstreamToken,
    clientToken,
    maxRpcBodyBytes: options.maxRpcBodyBytes ?? DEFAULT_MAX_RPC_BODY_BYTES,
    upstreamTimeoutMs: options.upstreamTimeoutMs ?? DEFAULT_UPSTREAM_TIMEOUT_MS,
    fetchImpl: options.fetchImpl ?? fetch,
  };
}

function normalizeBaseUrl(value: string, label: string): string {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error('unsupported protocol');
    }
    return parsed.toString().replace(/\/+$/, '');
  } catch (error) {
    throw new AppError('INVALID_ARGS', `Invalid ${label}`, { [label]: value }, error);
  }
}

function normalizeToken(value: string, label: string): string {
  const token = value.trim();
  if (!token) {
    throw new AppError('INVALID_ARGS', `Proxy ${label} is required.`);
  }
  return token;
}

function resolveProxyRoute(requestUrl: string): string {
  const pathname = new URL(requestUrl, 'http://127.0.0.1').pathname;
  if (pathname === DAEMON_HTTP_BASE_PATH) return '/';
  if (pathname.startsWith(DAEMON_PROXY_PREFIX)) {
    return `/${pathname.slice(DAEMON_PROXY_PREFIX.length)}`;
  }
  return pathname;
}

function isSupportedDaemonRoute(route: string, method: string | undefined): boolean {
  if (route === '/rpc') return method === 'POST';
  if (isSupportedUploadRoute(route, method)) return true;
  if (route.startsWith('/artifacts/')) return method === 'GET';
  return false;
}

function isSupportedUploadRoute(route: string, method: string | undefined): boolean {
  if (route === '/upload') return method === 'POST';
  if (isUploadPreflightRoute(route)) return method === 'POST';
  if (route === '/upload/finalize') return method === 'POST';
  if (route.startsWith('/upload/direct/')) return method === 'PUT';
  return false;
}

function isUploadPreflightRoute(route: string): boolean {
  return route === '/upload/preflight';
}

function buildUpstreamUrl(upstreamBaseUrl: string, route: string, rawUrl: string): URL {
  const upstreamUrl = new URL(buildDaemonHttpUrl(upstreamBaseUrl, route));
  const rawSearchIndex = rawUrl.indexOf('?');
  if (rawSearchIndex >= 0) upstreamUrl.search = rawUrl.slice(rawSearchIndex);
  return upstreamUrl;
}

function buildUpstreamHeaders(
  req: Pick<IncomingMessage, 'headers'>,
  upstreamToken: string,
  route: string,
): Headers {
  const headers = new Headers();
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = req.headers[name];
    if (typeof value === 'string' && value.trim()) headers.set(name, value);
  }
  if (route === '/rpc' && !headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }
  for (const [name, value] of Object.entries(buildDaemonHttpAuthHeaders(upstreamToken))) {
    headers.set(name, value);
  }
  return headers;
}

function resolveUpstreamBody(
  req: IncomingMessage,
  route: string,
  rpcBody: string | undefined,
  upstreamToken: string,
): BodyInit | undefined {
  if (req.method === 'GET' || req.method === 'HEAD') return undefined;
  if (route === '/rpc') return rewriteRpcToken(rpcBody ?? '', upstreamToken);
  return req as unknown as BodyInit;
}

function isAuthorized(req: IncomingMessage, expectedToken: string, rpcBody: string | undefined) {
  const requestToken = resolveRequestToken(req, rpcBody);
  return requestToken.length > 0 && timingSafeStringEqual(requestToken, expectedToken);
}

function resolveRequestToken(req: IncomingMessage, rpcBody: string | undefined): string {
  const authHeader = typeof req.headers.authorization === 'string' ? req.headers.authorization : '';
  if (authHeader.toLowerCase().startsWith('bearer ')) {
    return authHeader.slice('bearer '.length);
  }
  const tokenHeader = req.headers['x-agent-device-token'];
  if (typeof tokenHeader === 'string') return tokenHeader;
  if (rpcBody) {
    const bodyToken = readJsonRpcToken(rpcBody);
    if (bodyToken) return bodyToken;
  }
  return '';
}

function rewriteRpcToken(body: string, upstreamToken: string): string {
  const parsed = JSON.parse(body) as { params?: Record<string, unknown> };
  parsed.params = {
    ...(parsed.params ?? {}),
    token: upstreamToken,
  };
  return JSON.stringify(parsed);
}

function readJsonRpcToken(body: string): string {
  try {
    const parsed = JSON.parse(body) as { params?: { token?: unknown } };
    return typeof parsed.params?.token === 'string' ? parsed.params.token : '';
  } catch {
    return '';
  }
}

function readJsonRpcId(body: string | undefined): unknown {
  if (!body) return null;
  try {
    const parsed = JSON.parse(body) as { id?: unknown };
    return parsed.id ?? null;
  } catch {
    return null;
  }
}

function resolveRequestId(req: IncomingMessage): string {
  const header = req.headers['x-request-id'];
  if (typeof header === 'string' && header.trim()) return header.trim().slice(0, 128);
  return randomUUID();
}

function sendUnauthorized(res: ServerResponse, route: string, rpcId: unknown): void {
  res.statusCode = 401;
  res.setHeader('content-type', 'application/json');
  if (route === '/rpc') {
    res.end(
      JSON.stringify({
        jsonrpc: '2.0',
        id: rpcId,
        error: {
          code: -32001,
          message: 'Invalid proxy token',
          data: normalizeError(new AppError('UNAUTHORIZED', 'Invalid proxy token')),
        },
      }),
    );
    return;
  }
  res.end(
    JSON.stringify({
      ok: false,
      error: 'Invalid proxy token',
      code: 'UNAUTHORIZED',
    }),
  );
}

function sendProxyError(res: ServerResponse, error: unknown): void {
  if (res.headersSent) {
    res.destroy(error instanceof Error ? error : undefined);
    return;
  }
  const normalized = normalizeError(error);
  res.statusCode = normalized.code === 'INVALID_ARGS' ? 400 : 500;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ ok: false, error: normalized.message, code: normalized.code }));
}
