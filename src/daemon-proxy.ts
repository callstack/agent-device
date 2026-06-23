import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { randomUUID } from 'node:crypto';
import { AppError, normalizeError } from './utils/errors.ts';
import { timingSafeStringEqual } from './utils/timing-safe-equal.ts';
import {
  DAEMON_HTTP_BASE_PATH,
  buildDaemonHttpAuthHeaders,
  buildDaemonHttpUrl,
} from './daemon/http-contract.ts';
import { buildDaemonHealthPayload } from './daemon/http-health.ts';

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
const FORWARDED_REQUEST_HEADERS = ['content-type', 'x-artifact-type', 'x-artifact-filename'];
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
    rpcBody = (await readBodyBuffer(req, options.maxRpcBodyBytes)).toString('utf8');
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

  res.statusCode = response.status;
  for (const name of FORWARDED_RESPONSE_HEADERS) {
    const value = response.headers.get(name);
    if (value) res.setHeader(name, value);
  }
  if (!res.hasHeader('x-request-id')) {
    res.setHeader('x-request-id', resolveRequestId(req));
  }

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
  if (route === '/upload') return method === 'POST';
  if (route.startsWith('/artifacts/')) return method === 'GET';
  return false;
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

async function readBodyBuffer(req: IncomingMessage, maxBodyBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let bodyBytes = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bodyBytes += buffer.length;
    if (bodyBytes > maxBodyBytes) {
      throw new AppError('INVALID_ARGS', 'Proxy request body is too large.');
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
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
