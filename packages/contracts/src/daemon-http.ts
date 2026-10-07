// The daemon HTTP wire vocabulary shared by the daemon server, the remote
// proxy, and every client that talks to them: the base path, the tenant and
// network-access header names, the URL/auth/tenant header builders, and the
// /health payload. Client and server must agree on all of it, so neither side
// owns it (ADR 0006).
export const DAEMON_HTTP_BASE_PATH = '/agent-device';
export const DAEMON_HTTP_TENANT_HEADER = 'x-agent-device-tenant';
export const DAEMON_HTTP_NETWORK_ACCESS_HEADER = 'x-agent-device-network-access';
export const DAEMON_HTTP_PUBLIC_NETWORK_ACCESS = 'public-only';
/**
 * The principal the Host front-end authenticated (ADR 0021 §6). The daemon trusts it only on a
 * request that already carries the daemon token, and the proxy never forwards it from a client.
 */
export const DAEMON_HTTP_PRINCIPAL_HEADER = 'x-agent-device-principal';

export function buildDaemonHttpBaseUrl(baseUrl: string): string {
  return buildDaemonHttpUrl(baseUrl, DAEMON_HTTP_BASE_PATH);
}

export function buildDaemonHttpUrl(baseUrl: string, route: string): string {
  const normalizedBase = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  return new URL(route.replace(/^\/+/, ''), normalizedBase).toString();
}

export function buildDaemonHttpAuthHeaders(token: string | undefined): Record<string, string> {
  const normalizedToken = token?.trim();
  if (!normalizedToken) return {};
  return {
    authorization: `Bearer ${normalizedToken}`,
    'x-agent-device-token': normalizedToken,
  };
}

export function buildDaemonHttpTenantHeaders(tenantId: string | undefined): Record<string, string> {
  const normalizedTenantId = tenantId?.trim();
  if (!normalizedTenantId) return {};
  return { [DAEMON_HTTP_TENANT_HEADER]: normalizedTenantId };
}

// See docs/adr/0006-daemon-rpc-protocol-version.md before changing this value.
// Enforced, not just documented: `test/wire-compat/` digests the declarations
// that cross this boundary and fails when one changes shape without a bump or
// an acknowledged-compatible entry (#1432).
export const DAEMON_RPC_PROTOCOL_VERSION = 2;

export const DAEMON_HTTP_INSTANCE_HEADER = 'x-agent-device-instance';
export const DAEMON_HTTP_UPSTREAM_INSTANCE_HEADER = 'x-agent-device-upstream-instance';
export const DAEMON_HTTP_INSTANCE_MISMATCH_HEADER = 'x-agent-device-instance-mismatch';

export function buildDaemonInstanceMismatchRpcResponse<Id>(
  id: Id,
  message: string,
  data: Record<string, unknown>,
) {
  return { jsonrpc: '2.0' as const, id, error: { code: -32001, message, data } };
}

export type DaemonHealthPayload = {
  ok: true;
  service: 'agent-device-daemon' | 'agent-device-proxy' | typeof DAEMON_HOST_SERVICE;
  version: string;
  rpcProtocolVersion: number;
  instanceId?: string;
  hostArch?: string;
  /** The lease backends this daemon admits; a host checks it before relying on one. */
  leaseBackends?: readonly string[];
  /** Optional capabilities a client checks before sending a request that relies on one. */
  features?: readonly DaemonHealthFeature[];
  upstream?: unknown;
};

/**
 * Host allocates a fresh device per lease from a shape (`--device "iPhone 16"`) instead of a
 * local inventory identity (ADR 0021 §5). A client sends a shape only to a peer advertising it.
 */
export const DAEMON_HOST_DEVICE_SHAPE_FEATURE = 'device-shape';
/** The `service` a Host front-end reports, which a client reads to treat `--device` as a type. */
export const DAEMON_HOST_SERVICE = 'agent-device-host';
export type DaemonHealthFeature = typeof DAEMON_HOST_DEVICE_SHAPE_FEATURE;

export function buildDaemonHealthPayload(
  service: DaemonHealthPayload['service'],
  version: string,
  options: {
    upstream?: unknown;
    instanceId?: string;
    hostArch?: string;
    leaseBackends?: readonly string[];
    features?: readonly DaemonHealthFeature[];
  } = {},
): DaemonHealthPayload {
  return {
    ok: true,
    service,
    version,
    rpcProtocolVersion: DAEMON_RPC_PROTOCOL_VERSION,
    ...(options.instanceId !== undefined ? { instanceId: options.instanceId } : {}),
    ...(options.hostArch !== undefined ? { hostArch: options.hostArch } : {}),
    ...(options.leaseBackends !== undefined ? { leaseBackends: options.leaseBackends } : {}),
    ...(options.features !== undefined ? { features: options.features } : {}),
    ...(options.upstream !== undefined ? { upstream: options.upstream } : {}),
  };
}
