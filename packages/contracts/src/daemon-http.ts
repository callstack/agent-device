// The daemon HTTP wire vocabulary shared by the daemon server, the remote
// proxy, and every client that talks to them: the base path, the tenant and
// network-access header names, the URL/auth/tenant header builders, and the
// /health payload. Client and server must agree on all of it, so neither side
// owns it (ADR 0006).
export const DAEMON_HTTP_BASE_PATH = '/agent-device';
export const DAEMON_HTTP_TENANT_HEADER = 'x-agent-device-tenant';
export const DAEMON_HTTP_NETWORK_ACCESS_HEADER = 'x-agent-device-network-access';
export const DAEMON_HTTP_PUBLIC_NETWORK_ACCESS = 'public-only';

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

export type DaemonHealthPayload = {
  ok: true;
  service: 'agent-device-daemon' | 'agent-device-proxy';
  version: string;
  rpcProtocolVersion: number;
  upstream?: unknown;
};

export function buildDaemonHealthPayload(
  service: DaemonHealthPayload['service'],
  version: string,
  options: { upstream?: unknown } = {},
): DaemonHealthPayload {
  return {
    ok: true,
    service,
    version,
    rpcProtocolVersion: DAEMON_RPC_PROTOCOL_VERSION,
    ...(options.upstream !== undefined ? { upstream: options.upstream } : {}),
  };
}
