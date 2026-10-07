import {
  DAEMON_HTTP_BASE_PATH,
  DAEMON_HTTP_PRINCIPAL_HEADER,
  DAEMON_HTTP_TENANT_HEADER,
  DAEMON_RPC_PROTOCOL_VERSION,
} from '@agent-device/contracts/daemon-http';
import { timingSafeStringEqual } from '@agent-device/host-kit/transport';
import { AppError, normalizeError } from '@agent-device/kernel/errors';
import type { DaemonProxy } from '@agent-device/proxy';
import {
  findHostRpcRefusal,
  HOST_REFUSAL_REASONS,
  normalizeRpcMethod,
  stripClientIdentity,
  type HostRefusal,
} from './request-policy.ts';
import type { HostServiceCredential } from './service-credential.ts';

const HOST_SERVICE = 'agent-device-host';
const MAX_RPC_BODY_BYTES = 1024 * 1024;

/**
 * The Host public route policy in front of the daemon proxy (ADR 0021 §6). The proxy keeps
 * transport, auth and the daemon token rewrite; this layer refuses what a public caller may not
 * do and removes the identity a caller claims before the proxy forwards the request.
 */
export function createHostFrontEnd(
  proxy: DaemonProxy,
  credential: Pick<HostServiceCredential, 'token'>,
): DaemonProxy {
  return {
    instanceId: proxy.instanceId,
    handle: (request) => handleHostRequest(request, proxy, credential.token),
  };
}

/** The outbound loopback request: the server-controlled principal replaces any claimed tenant. */
export function withHostPrincipal(request: Request, principal: string): Request {
  const headers = new Headers(request.headers);
  headers.delete(DAEMON_HTTP_TENANT_HEADER);
  headers.set(DAEMON_HTTP_PRINCIPAL_HEADER, principal);
  return new Request(request, {
    headers,
    ...(request.body ? { duplex: 'half' } : {}),
  } as RequestInit);
}

async function handleHostRequest(
  request: Request,
  proxy: DaemonProxy,
  token: string,
): Promise<Response> {
  const route = resolveRoute(request.url);
  if (route === '/admin' || route.startsWith('/admin/')) {
    return restRefusal({
      reason: HOST_REFUSAL_REASONS.admin,
      message: 'Host does not serve administration routes.',
    });
  }
  if (route === '/health' && request.method === 'GET') {
    return await hostHealth(request, proxy, token);
  }
  if (route === '/rpc' && request.method === 'POST') return await hostRpc(request, proxy, token);
  return await proxy.handle(request);
}

async function hostHealth(request: Request, proxy: DaemonProxy, token: string): Promise<Response> {
  if (!hasHeaderToken(request.headers, token)) {
    return Response.json({
      ok: true,
      service: HOST_SERVICE,
      rpcProtocolVersion: DAEMON_RPC_PROTOCOL_VERSION,
    });
  }
  const response = await proxy.handle(request);
  if (!response.ok) return response;
  const payload = (await response.json()) as Record<string, unknown>;
  return Response.json({ ...payload, service: HOST_SERVICE }, { status: response.status });
}

async function hostRpc(request: Request, proxy: DaemonProxy, token: string): Promise<Response> {
  const body = await readBoundedText(request, MAX_RPC_BODY_BYTES);
  const rpc = parseRpc(body);
  // The proxy answers malformed, oversized and unauthorized requests exactly as it always does.
  if (!rpc || !isAuthorized(request.headers, rpc.params, token)) {
    return await proxy.handle(withBody(request, body));
  }
  const refusal = findHostRpcRefusal(normalizeRpcMethod(rpc.method), rpc.params);
  if (refusal) return rpcRefusal(rpc.id, refusal);
  const forwarded = { ...rpc.envelope, params: stripClientIdentity(rpc.params) };
  return await proxy.handle(withBody(request, JSON.stringify(forwarded)));
}

type ParsedRpc = {
  envelope: Record<string, unknown>;
  id: unknown;
  method: string;
  params: Record<string, unknown>;
};

function parseRpc(body: string): ParsedRpc | undefined {
  try {
    const envelope = JSON.parse(body) as Record<string, unknown>;
    const params = envelope?.params;
    if (typeof envelope?.method !== 'string' || !params || typeof params !== 'object') {
      return undefined;
    }
    return {
      envelope,
      id: envelope.id,
      method: envelope.method,
      params: params as Record<string, unknown>,
    };
  } catch {
    return undefined;
  }
}

function isAuthorized(headers: Headers, params: Record<string, unknown>, token: string): boolean {
  const presented = readHeaderToken(headers) ?? params.token;
  return typeof presented === 'string' && timingSafeStringEqual(presented, token);
}

function hasHeaderToken(headers: Headers, token: string): boolean {
  const presented = readHeaderToken(headers);
  return presented !== undefined && timingSafeStringEqual(presented, token);
}

function readHeaderToken(headers: Headers): string | undefined {
  const authorization = headers.get('authorization') ?? '';
  if (authorization.toLowerCase().startsWith('bearer ')) {
    return authorization.slice('bearer '.length);
  }
  return headers.get('x-agent-device-token') ?? undefined;
}

async function readBoundedText(request: Request, limit: number): Promise<string> {
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (size <= limit) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.byteLength;
  }
  if (size > limit) await reader.cancel();
  return Buffer.concat(chunks).toString('utf8');
}

function withBody(request: Request, body: string): Request {
  return new Request(request.url, {
    method: request.method,
    headers: request.headers,
    body,
    signal: request.signal,
  });
}

function resolveRoute(url: string): string {
  const pathname = URL.parse(url)?.pathname ?? '';
  if (pathname === DAEMON_HTTP_BASE_PATH) return '/';
  return pathname.startsWith(`${DAEMON_HTTP_BASE_PATH}/`)
    ? pathname.slice(DAEMON_HTTP_BASE_PATH.length)
    : pathname;
}

function refusalError(refusal: HostRefusal) {
  return normalizeError(
    new AppError('UNSUPPORTED_OPERATION', refusal.message, {
      reason: refusal.reason,
      ...(refusal.field ? { field: refusal.field } : {}),
      hint: 'Host serves remote verification only; see agent-device help host.',
    }),
  );
}

function rpcRefusal(id: unknown, refusal: HostRefusal): Response {
  const data = refusalError(refusal);
  return Response.json(
    { jsonrpc: '2.0', id: id ?? null, error: { code: -32000, message: data.message, data } },
    { status: 403 },
  );
}

function restRefusal(refusal: HostRefusal): Response {
  const data = refusalError(refusal);
  return Response.json(
    { ok: false, error: data.message, code: data.code, details: data.details },
    { status: 403 },
  );
}
