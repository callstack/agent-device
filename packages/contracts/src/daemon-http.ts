import path from 'node:path';

// The daemon HTTP wire vocabulary shared by the daemon server, the remote
// proxy, and every client that talks to them: the base path, the tenant and
// network-access header names, the URL/auth/tenant header builders, the
// /health payload, and the temp artifact paths a remote client names on the
// daemon host. Client and server must agree on all of it, so neither side
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
  service: 'agent-device-daemon' | 'agent-device-proxy';
  version: string;
  rpcProtocolVersion: number;
  instanceId?: string;
  hostArch?: string;
  /** The lease backends this daemon admits; a host checks it before relying on one. */
  leaseBackends?: readonly string[];
  upstream?: unknown;
};

export function buildDaemonHealthPayload(
  service: DaemonHealthPayload['service'],
  version: string,
  options: {
    upstream?: unknown;
    instanceId?: string;
    hostArch?: string;
    leaseBackends?: readonly string[];
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
    ...(options.upstream !== undefined ? { upstream: options.upstream } : {}),
  };
}

// A remote client names a daemon-host temp path for each artifact it downloads afterwards, and the
// daemon accepts exactly that shape where it otherwise refuses host paths.
const REMOTE_TEMP_DIR = '/tmp';

/** The daemon-host temp path a remote client names for an artifact it downloads afterwards. */
export function buildRemoteTempArtifactPath(prefix: string, extension: string): string {
  return path.posix.join(
    REMOTE_TEMP_DIR,
    `${remoteTempArtifactStem(prefix)}${dottedExtension(extension)}`,
  );
}

/** A directory temp path — unlike `buildRemoteTempArtifactPath`, no extension is ever appended. */
export function buildRemoteTempArtifactDirPath(prefix: string): string {
  return path.posix.join(REMOTE_TEMP_DIR, remoteTempArtifactStem(prefix));
}

/** Whether `value` has the shape `buildRemoteTempArtifactPath(prefix, extension)` returns. */
export function isRemoteTempArtifactPath(
  value: string,
  prefix: string,
  extension: string,
): boolean {
  const dotted = dottedExtension(extension);
  const stem = path.posix.basename(value, dotted);
  return (
    value === path.posix.join(REMOTE_TEMP_DIR, `${stem}${dotted}`) &&
    stem.startsWith(`agent-device-${prefix}-`) &&
    /^\d+-[a-z0-9]+$/.test(stem.slice(`agent-device-${prefix}-`.length))
  );
}

function dottedExtension(extension: string): string {
  return extension.startsWith('.') ? extension : `.${extension}`;
}

function remoteTempArtifactStem(prefix: string): string {
  return `agent-device-${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}
