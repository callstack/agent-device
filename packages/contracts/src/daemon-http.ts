import path from 'node:path';

// The daemon HTTP wire vocabulary shared by the daemon server, the remote
// proxy, and every client that talks to them: the base path, the tenant, lease
// and network-access header names, the URL/auth/tenant/lease header builders, the
// /health payload, and the temp artifact paths a remote client names on the
// daemon host. Client and server must agree on all of it, so neither side
// owns it (ADR 0006).
export const DAEMON_HTTP_BASE_PATH = '/agent-device';
export const DAEMON_HTTP_TENANT_HEADER = 'x-agent-device-tenant';
// Names the lease a non-RPC request (upload, artifact download, request diagnostics) belongs to,
// as RPC calls name it in their body. Neither the daemon nor the proxy reads it; it lets a gateway
// in front of many daemons route those requests to the one holding the lease.
export const DAEMON_HTTP_LEASE_HEADER = 'x-agent-device-lease-id';
export const DAEMON_HTTP_NETWORK_ACCESS_HEADER = 'x-agent-device-network-access';
export const DAEMON_HTTP_PUBLIC_NETWORK_ACCESS = 'public-only';

/** Normalize an absolute HTTP(S) origin, or throw when it contains other URL components. */
export function normalizeDaemonPublicOrigin(value: string): string {
  if (!/^https?:\/\/[^\s/?#]+\/?$/i.test(value) || containsInvalidHttpUrlCharacter(value)) {
    throw new Error('Invalid publicOrigin');
  }
  const authority = value.match(/^https?:\/\/([^/]+)/i)?.[1] ?? '';
  if (authority.includes('@') || authority.endsWith(':')) throw new Error('Invalid publicOrigin');
  const url = new URL(value);
  if (
    !url.hostname ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  ) {
    throw new Error('Invalid publicOrigin');
  }
  return url.origin;
}

/** Validate a Node origin-form request target and its single Host header. */
export function nodeHttpRequestUrl(
  target: string | undefined,
  rawHeaders: readonly string[],
  secure: boolean,
): URL | null {
  if (
    !target ||
    !target.startsWith('/') ||
    target.startsWith('//') ||
    target.includes('#') ||
    containsInvalidHttpUrlCharacter(target)
  )
    return null;
  const origin = resolveHttpRequestBaseUrl(rawHeaders, secure);
  return origin === null ? null : new URL(target, origin);
}

function resolveHttpRequestBaseUrl(rawHeaders: readonly string[], secure: boolean): string | null {
  const hosts: string[] = [];
  for (let i = 0; i + 1 < rawHeaders.length; i += 2) {
    if (rawHeaders[i]?.toLowerCase() === 'host') hosts.push(rawHeaders[i + 1] ?? '');
  }
  if (hosts.length !== 1 || /[/?#]/.test(hosts[0] ?? '')) return null;
  try {
    return normalizeDaemonPublicOrigin(`${secure ? 'https' : 'http'}://${hosts[0]}`);
  } catch {
    return null;
  }
}

function containsInvalidHttpUrlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 32 || code === 127 || character === '\\') return true;
  }
  return false;
}

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

/** The tenant id every daemon route accepts, trimmed, or `undefined` when it breaks the rule. */
export function normalizeTenantId(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const value = raw.trim();
  if (!value) return undefined;
  if (!/^[a-zA-Z0-9._-]{1,128}$/.test(value)) return undefined;
  return value;
}

/** Whether `sessionName` lies beneath the `<tenant>:` prefix tenant isolation names sessions with. */
export function isTenantOwnedSessionName(tenant: string, sessionName: string): boolean {
  return sessionName.startsWith(`${tenant}:`);
}

export function buildDaemonHttpTenantHeaders(tenantId: string | undefined): Record<string, string> {
  const normalizedTenantId = tenantId?.trim();
  if (!normalizedTenantId) return {};
  return { [DAEMON_HTTP_TENANT_HEADER]: normalizedTenantId };
}

export function buildDaemonHttpLeaseHeaders(leaseId: string | undefined): Record<string, string> {
  const normalizedLeaseId = leaseId?.trim();
  if (!normalizedLeaseId) return {};
  return { [DAEMON_HTTP_LEASE_HEADER]: normalizedLeaseId };
}

// See docs/adr/0006-daemon-rpc-protocol-version.md before changing this value.
// Enforced, not just documented: `test/wire-compat/` digests the declarations
// that cross this boundary and fails when one changes shape without a bump or
// an acknowledged-compatible entry (#1432).
export const DAEMON_RPC_PROTOCOL_VERSION = 2;

/**
 * The largest serialized daemon request, in UTF-8 bytes, that any transport reads: the socket
 * line, the HTTP `/rpc` body, and the proxy's `/rpc` body. Clients refuse a larger request before
 * sending it. It sits well above what a client builds: `test` inlines one replay bundle per flow,
 * each up to 2 MiB before JSON escaping, so 64 MiB fits a suite of several maximum-size flows with
 * worst-case escaping. It also bounds the memory one unauthenticated connection can hold.
 */
export const DAEMON_REQUEST_MAX_BYTES = 64 * 1024 * 1024;

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
  /** The daemon can publish session scripts as downloadable artifacts. */
  capabilities?: readonly string[];
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
    capabilities?: readonly string[];
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
    ...(options.capabilities !== undefined ? { capabilities: options.capabilities } : {}),
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
