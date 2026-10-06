import { randomUUID } from 'node:crypto';
import { AppError, normalizeError } from '@agent-device/kernel/errors';
import { timingSafeStringEqual } from '@agent-device/host-kit/transport';
import {
  buildDaemonHealthPayload,
  buildDaemonInstanceMismatchRpcResponse,
  DAEMON_HTTP_BASE_PATH,
  DAEMON_HTTP_INSTANCE_HEADER,
  DAEMON_HTTP_INSTANCE_MISMATCH_HEADER,
  DAEMON_HTTP_UPSTREAM_INSTANCE_HEADER,
  DAEMON_HTTP_NETWORK_ACCESS_HEADER,
  DAEMON_HTTP_PUBLIC_NETWORK_ACCESS,
  DAEMON_HTTP_TENANT_HEADER,
  buildDaemonHttpAuthHeaders,
  buildDaemonHttpUrl,
} from '@agent-device/contracts/daemon-http';
import {
  carriesUnbackedHostPathInstallSource,
  hostPathInstallSourceRefusedResponse,
} from './install-source-admission.ts';

/**
 * Carries one request to the upstream daemon and resolves with its response. The default is the
 * global `fetch`; supply your own to reach the daemon over another transport, such as a
 * WebSocket tunnel. Abort the exchange when `request.signal` aborts.
 */
export type DaemonProxyUpstreamFetch = (request: Request) => Promise<Response>;

export type DaemonProxyOptions = {
  /** Base URL of the upstream agent-device daemon HTTP server. */
  upstreamBaseUrl: string;
  /** Auth token of the upstream daemon. Never leaves the proxy. */
  upstreamToken: string;
  /** Token proxy clients must present as their daemon auth token. */
  clientToken: string;
  maxRpcBodyBytes?: number;
  upstreamTimeoutMs?: number;
  upstreamFetch?: DaemonProxyUpstreamFetch;
};

export type DaemonProxy = {
  /** Identifies this proxy instance in its health payload, so clients notice a restart. */
  readonly instanceId: string;
  /**
   * Answers one client request. `request.url` must be the URL the client used, because upload
   * tickets are rewritten to its origin; an `x-forwarded-proto` header overrides its scheme.
   * Abort `request.signal` when the client goes away so in-flight daemon work is cancelled.
   * Resolves with an error response rather than rejecting.
   */
  handle(request: Request): Promise<Response>;
};

type NormalizedProxyOptions = Required<DaemonProxyOptions>;

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
  DAEMON_HTTP_TENANT_HEADER,
];
const FORWARDED_RESPONSE_HEADERS = [
  'content-type',
  'content-disposition',
  'x-request-id',
  DAEMON_HTTP_INSTANCE_MISMATCH_HEADER,
];

export function createDaemonProxy(options: DaemonProxyOptions): DaemonProxy {
  const normalized = normalizeProxyOptions(options);
  const instanceId = randomUUID();
  return {
    instanceId,
    handle: async (request) => {
      try {
        return await handleProxyRequest(request, normalized, instanceId);
      } catch (error) {
        return proxyErrorResponse(error);
      }
    },
  };
}

async function handleProxyRequest(
  request: Request,
  options: NormalizedProxyOptions,
  instanceId: string,
): Promise<Response> {
  const route = resolveProxyRoute(request.url);
  if (request.method === 'GET' && route === '/health') {
    return await proxyHealthResponse(request, options, instanceId);
  }

  if (!isSupportedDaemonRoute(route, request.method)) {
    return new Response(new TextEncoder().encode('Not found'), { status: 404 });
  }

  let rpcBody: string | undefined;
  if (route === '/rpc') {
    rpcBody = await readRequestText(
      request,
      options.maxRpcBodyBytes,
      'Proxy request body is too large.',
    );
  }

  if (!isAuthorized(request, options.clientToken, rpcBody)) {
    return unauthorizedResponse(route, readJsonRpcId(rpcBody));
  }

  const staleInstance = refuseStaleProxyInstance(
    request,
    route,
    readJsonRpcId(rpcBody),
    instanceId,
  );
  if (staleInstance) return staleInstance;

  if (carriesUnbackedHostPathInstallSource(rpcBody)) {
    return hostPathInstallSourceRefusedResponse(readJsonRpcId(rpcBody));
  }

  return await forwardProxyRequest({ request, route, options, rpcBody });
}

async function proxyHealthResponse(
  request: Request,
  options: NormalizedProxyOptions,
  instanceId: string,
): Promise<Response> {
  const [upstream, { readVersion }, { readHostCpuArch }] = await Promise.all([
    readUpstreamHealth(request, options),
    import('@agent-device/host-kit/version'),
    import('@agent-device/host-kit/process'),
  ]);
  return Response.json(
    buildDaemonHealthPayload('agent-device-proxy', readVersion(), {
      upstream,
      instanceId,
      hostArch: await readHostCpuArch(),
    }),
  );
}

async function readUpstreamHealth(
  request: Request,
  options: NormalizedProxyOptions,
): Promise<unknown> {
  const response = await options.upstreamFetch(
    new Request(buildDaemonHttpUrl(options.upstreamBaseUrl, 'health'), {
      method: 'GET',
      headers: buildUpstreamHeaders(new Headers(), options.upstreamToken, '/health'),
      signal: upstreamSignal(request, options),
    }),
  );
  const text = await response.text();
  try {
    return text ? JSON.parse(text) : { ok: response.ok, status: response.status };
  } catch {
    return { ok: response.ok, status: response.status };
  }
}

async function forwardProxyRequest(params: {
  request: Request;
  route: string;
  options: NormalizedProxyOptions;
  rpcBody?: string;
}): Promise<Response> {
  const { request, route, options, rpcBody } = params;
  const body = resolveUpstreamBody(request, route, rpcBody, options.upstreamToken);
  const upstreamResponse = await options.upstreamFetch(
    new Request(buildUpstreamUrl(options.upstreamBaseUrl, route, request.url), {
      method: request.method,
      headers: buildUpstreamHeaders(request.headers, options.upstreamToken, route),
      signal: upstreamSignal(request, options),
      ...(body ? { body, duplex: 'half' as const } : {}),
    }),
  );

  const headers = copyProxyResponseHeaders(upstreamResponse, request);
  if (isUploadPreflightRoute(route)) {
    return await rewrittenUploadPreflightResponse({
      request,
      upstreamResponse,
      headers,
      clientToken: options.clientToken,
    });
  }
  return new Response(upstreamResponse.body, { status: upstreamResponse.status, headers });
}

/**
 * An upstream exchange lives exactly as long as the client keeps waiting for it: the daemon
 * turns a dropped upstream request into cancellation of in-flight runner work.
 */
function upstreamSignal(request: Request, options: NormalizedProxyOptions): AbortSignal {
  return AbortSignal.any([request.signal, AbortSignal.timeout(options.upstreamTimeoutMs)]);
}

function copyProxyResponseHeaders(upstreamResponse: Response, request: Request): Headers {
  const headers = new Headers();
  for (const name of FORWARDED_RESPONSE_HEADERS) {
    const value = upstreamResponse.headers.get(name);
    if (value) headers.set(name, value);
  }
  if (!headers.has('x-request-id')) headers.set('x-request-id', resolveRequestId(request));
  return headers;
}

async function rewrittenUploadPreflightResponse(params: {
  request: Request;
  upstreamResponse: Response;
  headers: Headers;
  clientToken: string;
}): Promise<Response> {
  const { request, upstreamResponse, headers, clientToken } = params;
  const text = await upstreamResponse.text();
  headers.set('content-type', upstreamResponse.headers.get('content-type') ?? 'application/json');
  return new Response(rewriteUploadPreflightResponse(text, request, clientToken), {
    status: upstreamResponse.status,
    headers,
  });
}

function rewriteUploadPreflightResponse(
  body: string,
  request: Request,
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

  const rewrittenUrl = rewriteUploadDirectUrl(record.upload.url, request);
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

function rewriteUploadDirectUrl(upstreamUrl: string, request: Request): string | null {
  let parsed: URL;
  try {
    parsed = new URL(upstreamUrl);
  } catch {
    return null;
  }

  if (!parsed.pathname.startsWith('/upload/')) {
    return null;
  }

  const requestUrl = new URL(request.url);
  const uploadIndex = requestUrl.pathname.lastIndexOf('/upload/preflight');
  const uploadPrefix = uploadIndex >= 0 ? requestUrl.pathname.slice(0, uploadIndex) : '';
  const forwardedProto = request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim();
  const rewritten = new URL(
    `${forwardedProto || requestUrl.protocol.replace(/:$/, '')}://${requestUrl.host}`,
  );
  rewritten.pathname = `${uploadPrefix}${parsed.pathname}`;
  rewritten.search = parsed.search;
  return rewritten.toString();
}

function normalizeProxyOptions(options: DaemonProxyOptions): NormalizedProxyOptions {
  const upstreamBaseUrl = normalizeBaseUrl(options.upstreamBaseUrl, 'upstreamBaseUrl');
  const upstreamToken = normalizeToken(options.upstreamToken, 'upstreamToken');
  const clientToken = normalizeToken(options.clientToken, 'clientToken');
  return {
    upstreamBaseUrl,
    upstreamToken,
    clientToken,
    maxRpcBodyBytes: options.maxRpcBodyBytes ?? DEFAULT_MAX_RPC_BODY_BYTES,
    upstreamTimeoutMs: options.upstreamTimeoutMs ?? DEFAULT_UPSTREAM_TIMEOUT_MS,
    upstreamFetch: options.upstreamFetch ?? ((request) => fetch(request)),
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
  const pathname = new URL(requestUrl).pathname;
  if (pathname === DAEMON_HTTP_BASE_PATH) return '/';
  if (pathname.startsWith(DAEMON_PROXY_PREFIX)) {
    return `/${pathname.slice(DAEMON_PROXY_PREFIX.length)}`;
  }
  return pathname;
}

function isSupportedDaemonRoute(route: string, method: string): boolean {
  if (route === '/rpc') return method === 'POST';
  if (isSupportedUploadRoute(route, method)) return true;
  if (route === '/artifacts' || route === '/artifacts/') return method === 'GET';
  if (route.startsWith('/artifacts/')) return method === 'GET';
  if (isRequestDiagnosticsRoute(route)) return method === 'GET';
  return false;
}

/**
 * `GET /sessions/<session>/requests/<requestId>/diagnostics` (#1801): the record a failed
 * command names. A remote client localizes its `logPath` from it, so a client behind the
 * proxy keeps exactly the failure envelope a client on the daemon host gets.
 */
function isRequestDiagnosticsRoute(route: string): boolean {
  const segments = route.split('/');
  return (
    segments.length === 6 &&
    segments[1] === 'sessions' &&
    segments[3] === 'requests' &&
    segments[5] === 'diagnostics' &&
    segments[2] !== '' &&
    segments[4] !== ''
  );
}

function isSupportedUploadRoute(route: string, method: string): boolean {
  if (route === '/upload') return method === 'POST';
  if (isUploadPreflightRoute(route)) return method === 'POST';
  if (route === '/upload/finalize') return method === 'POST';
  if (route.startsWith('/upload/direct/')) return method === 'PUT';
  return false;
}

function isUploadPreflightRoute(route: string): boolean {
  return route === '/upload/preflight';
}

function buildUpstreamUrl(upstreamBaseUrl: string, route: string, requestUrl: string): URL {
  const upstreamUrl = new URL(buildDaemonHttpUrl(upstreamBaseUrl, route));
  upstreamUrl.search = new URL(requestUrl).search;
  return upstreamUrl;
}

function buildUpstreamInstancePreconditionHeaders(requestHeaders: Headers): Record<string, string> {
  const expectedUpstreamInstance = requestHeaders.get(DAEMON_HTTP_UPSTREAM_INSTANCE_HEADER);
  return expectedUpstreamInstance !== null
    ? { [DAEMON_HTTP_INSTANCE_HEADER]: expectedUpstreamInstance }
    : {};
}

function buildUpstreamHeaders(
  requestHeaders: Headers,
  upstreamToken: string,
  route: string,
): Headers {
  const headers = new Headers();
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = requestHeaders.get(name);
    if (value?.trim()) headers.set(name, value);
  }
  if (route === '/rpc' && !headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }
  if (route === '/rpc') {
    headers.set(DAEMON_HTTP_NETWORK_ACCESS_HEADER, DAEMON_HTTP_PUBLIC_NETWORK_ACCESS);
    for (const [name, value] of Object.entries(
      buildUpstreamInstancePreconditionHeaders(requestHeaders),
    )) {
      headers.set(name, value);
    }
  }
  for (const [name, value] of Object.entries(buildDaemonHttpAuthHeaders(upstreamToken))) {
    headers.set(name, value);
  }
  return headers;
}

function resolveUpstreamBody(
  request: Request,
  route: string,
  rpcBody: string | undefined,
  upstreamToken: string,
): BodyInit | null {
  if (request.method === 'GET' || request.method === 'HEAD') return null;
  if (route === '/rpc') return rewriteRpcToken(rpcBody ?? '', upstreamToken);
  return request.body;
}

async function readRequestText(
  request: Request,
  maxBodyBytes: number,
  tooLargeMessage: string,
): Promise<string> {
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let bodyBytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bodyBytes += value.byteLength;
    if (bodyBytes > maxBodyBytes) {
      await reader.cancel();
      throw new AppError('INVALID_ARGS', tooLargeMessage);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function isAuthorized(request: Request, expectedToken: string, rpcBody: string | undefined) {
  const requestToken = resolveRequestToken(request, rpcBody);
  return requestToken.length > 0 && timingSafeStringEqual(requestToken, expectedToken);
}

function resolveRequestToken(request: Request, rpcBody: string | undefined): string {
  const authHeader = request.headers.get('authorization') ?? '';
  if (authHeader.toLowerCase().startsWith('bearer ')) {
    return authHeader.slice('bearer '.length);
  }
  const tokenHeader = request.headers.get('x-agent-device-token');
  if (tokenHeader !== null) return tokenHeader;
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

function resolveRequestId(request: Request): string {
  const header = request.headers.get('x-request-id');
  if (header?.trim()) return header.trim().slice(0, 128);
  return randomUUID();
}

function refuseStaleProxyInstance(
  request: Request,
  route: string,
  rpcId: unknown,
  instanceId: string,
): Response | null {
  if (route !== '/rpc') return null;
  const expectedInstanceId = request.headers.get(DAEMON_HTTP_INSTANCE_HEADER);
  if (expectedInstanceId === null || expectedInstanceId === instanceId) return null;
  return sendInstanceMismatch(rpcId);
}

function sendInstanceMismatch(rpcId: unknown): Response {
  return Response.json(
    buildDaemonInstanceMismatchRpcResponse(
      rpcId,
      'Proxy instance changed',
      normalizeError(
        new AppError('COMMAND_FAILED', 'Proxy instance changed', {
          reason: 'remote_instance_mismatch',
        }),
      ),
    ),
    { status: 409, headers: { [DAEMON_HTTP_INSTANCE_MISMATCH_HEADER]: 'true' } },
  );
}

function unauthorizedResponse(route: string, rpcId: unknown): Response {
  if (route === '/rpc') {
    return Response.json(
      {
        jsonrpc: '2.0',
        id: rpcId,
        error: {
          code: -32001,
          message: 'Invalid proxy token',
          data: normalizeError(new AppError('UNAUTHORIZED', 'Invalid proxy token')),
        },
      },
      { status: 401 },
    );
  }
  return Response.json(
    { ok: false, error: 'Invalid proxy token', code: 'UNAUTHORIZED' },
    { status: 401 },
  );
}

function proxyErrorResponse(error: unknown): Response {
  const normalized = normalizeError(error);
  return Response.json(
    { ok: false, error: normalized.message, code: normalized.code },
    { status: normalized.code === 'INVALID_ARGS' ? 400 : 500 },
  );
}
