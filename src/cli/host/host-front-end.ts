import {
  DAEMON_HTTP_BASE_PATH,
  DAEMON_HTTP_PRINCIPAL_HEADER,
  DAEMON_HTTP_TENANT_HEADER,
  DAEMON_RPC_PROTOCOL_VERSION,
} from '@agent-device/contracts/daemon-http';
import { timingSafeStringEqual } from '@agent-device/host-kit/transport';
import { AppError, normalizeError } from '@agent-device/kernel/errors';
import type { DaemonProxy, DaemonProxyRpcAdmission } from '@agent-device/proxy';
import {
  findHostRpcRefusal,
  normalizeRpcMethod,
  stripClientIdentity,
  type HostRefusal,
} from './request-policy.ts';
import type { HostServiceCredential } from './service-credential.ts';

const HOST_SERVICE = 'agent-device-host';
const HEALTH_PATHS: ReadonlySet<string> = new Set(['/health', `${DAEMON_HTTP_BASE_PATH}/health`]);

/**
 * The Host public route policy (ADR 0021 §6), applied by the proxy after it authenticated the
 * request: refuse what a public caller may not do, and drop the identity it claims.
 */
export const admitHostRpc: DaemonProxyRpcAdmission = ({ id, method, params }) => {
  const refusal = findHostRpcRefusal(normalizeRpcMethod(method), params);
  return refusal ? rpcRefusal(id, refusal) : stripClientIdentity(params);
};

/**
 * The Host front-end around the daemon proxy. Only `/health` differs from the proxy: anonymous
 * callers see minimal status, and authenticated ones see the Host and the daemon's features.
 */
export function createHostFrontEnd(
  proxy: DaemonProxy,
  credential: Pick<HostServiceCredential, 'token'>,
): DaemonProxy {
  return {
    instanceId: proxy.instanceId,
    handle: async (request) => {
      try {
        return await handleHostRequest(request, proxy, credential.token);
      } catch (error) {
        const normalized = normalizeError(error);
        return Response.json(
          { ok: false, error: normalized.message, code: normalized.code },
          {
            status: normalized.code === 'INVALID_ARGS' ? 400 : 500,
          },
        );
      }
    },
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
  const pathname = URL.parse(request.url)?.pathname ?? '';
  if (request.method !== 'GET' || !HEALTH_PATHS.has(pathname)) return await proxy.handle(request);
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

function hasHeaderToken(headers: Headers, token: string): boolean {
  const authorization = headers.get('authorization') ?? '';
  const presented = authorization.toLowerCase().startsWith('bearer ')
    ? authorization.slice('bearer '.length)
    : headers.get('x-agent-device-token');
  return presented !== null && timingSafeStringEqual(presented, token);
}

function rpcRefusal(id: unknown, refusal: HostRefusal): Response {
  const data = normalizeError(
    new AppError('UNSUPPORTED_OPERATION', refusal.message, {
      reason: refusal.reason,
      ...(refusal.field ? { field: refusal.field } : {}),
      hint: 'Host serves remote verification only; see agent-device help host.',
    }),
  );
  return Response.json(
    { jsonrpc: '2.0', id: id ?? null, error: { code: -32000, message: data.message, data } },
    { status: 403 },
  );
}
