import type http from 'node:http';
import type { DeviceLease } from '@agent-device/contracts/device';
import { AppError, normalizeError } from '@agent-device/kernel/errors';
import { sendRestJsonError } from './http-errors.ts';
import {
  assertHostAdminAuthorized,
  readHostAdminJsonBody,
  sendJson,
  tryHandleHumanControlHttpRoute,
} from './human-control-http.ts';
import type { LeaseRegistry } from './lease-registry.ts';
import {
  leaseReleaseRequestFor,
  normalizeRequiredLeaseId,
  type AllocateLeaseRequest,
} from './lease-registry-scope.ts';
import { parseMacOsAppLeaseKey } from './macos-app-lease.ts';

/**
 * Host-only lease administration on the daemon's loopback listener. `agent-device proxy` forwards
 * only the tenant routes, so a tenant never reaches this; it is how a host allocates the lease that
 * confines a client, which is why a `macos-app` lease is allocated here and nowhere else.
 */
export const HOST_LEASE_HTTP_PREFIX = '/admin/leases';

const HOST_LEASE_FIELDS = new Set([
  'tenantId',
  'runId',
  'clientId',
  'leaseBackend',
  'leaseProvider',
  'deviceKey',
  'ttlMs',
  'retainOnClose',
]);

type HostLeaseRoute =
  | { kind: 'list' }
  | { kind: 'put'; leaseId: string }
  | { kind: 'remove'; leaseId: string }
  | { kind: 'unsupported' };

type HostAdminHttpParams = {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  expectedToken: string;
  registry: LeaseRegistry;
};

/** Every host administration route: lease allocation and human-control holds. */
export function tryHandleHostAdminHttpRoute(params: HostAdminHttpParams): boolean {
  return tryHandleHostLeaseHttpRoute(params) || tryHandleHumanControlHttpRoute(params);
}

function tryHandleHostLeaseHttpRoute(params: HostAdminHttpParams): boolean {
  const route = resolveHostLeaseRoute(params.req);
  if (!route) return false;
  void handleHostLeaseRoute(route, params).catch((error: unknown) => {
    sendRestJsonError(params.res, normalizeError(error));
  });
  return true;
}

async function handleHostLeaseRoute(
  route: HostLeaseRoute,
  params: HostAdminHttpParams,
): Promise<void> {
  const { req, res, registry } = params;
  assertHostAdminAuthorized(req, params.expectedToken);
  switch (route.kind) {
    case 'list':
      sendJson(res, { ok: true, leases: registry.listActiveLeases().filter(isMacOsAppLease) });
      return;
    case 'put': {
      const request = parseHostLeaseRequest(await readHostAdminJsonBody(req, 'Host lease'));
      sendJson(res, { ok: true, lease: registry.putHostLease(route.leaseId, request) });
      return;
    }
    case 'remove': {
      const leaseId = normalizeRequiredLeaseId(route.leaseId);
      const lease = registry.listActiveLeases().find((entry) => entry.leaseId === leaseId);
      const released = lease
        ? registry.releaseLease(leaseReleaseRequestFor(lease)).released
        : false;
      sendJson(res, { ok: true, released, ...(lease && released ? { lease } : {}) });
      return;
    }
    case 'unsupported':
      res.statusCode = 405;
      res.setHeader('allow', 'GET, PUT, DELETE');
      sendJson(res, { ok: false, error: 'Method not allowed', code: 'INVALID_ARGS' });
      return;
  }
}

function isMacOsAppLease(lease: DeviceLease): boolean {
  return lease.backend === 'macos-app';
}

function resolveHostLeaseRoute(req: http.IncomingMessage): HostLeaseRoute | null {
  const pathname = URL.parse(req.url ?? '/', 'http://127.0.0.1')?.pathname ?? '';
  if (pathname === HOST_LEASE_HTTP_PREFIX) {
    return req.method === 'GET' ? { kind: 'list' } : { kind: 'unsupported' };
  }
  if (!pathname.startsWith(`${HOST_LEASE_HTTP_PREFIX}/`)) return null;
  return resolveLeaseIdRoute(pathname.slice(HOST_LEASE_HTTP_PREFIX.length + 1), req.method);
}

function resolveLeaseIdRoute(leaseId: string, method: string | undefined): HostLeaseRoute {
  const kind = HOST_LEASE_METHODS[method ?? ''];
  if (!kind || !leaseId || leaseId.includes('/')) return { kind: 'unsupported' };
  return { kind, leaseId };
}

const HOST_LEASE_METHODS: Readonly<Record<string, 'put' | 'remove'>> = {
  PUT: 'put',
  DELETE: 'remove',
};

/**
 * Only `macos-app` leases are allocated here today. The lease outlives its client's `close` unless
 * the host says otherwise: the host owns its lifetime and ends it with DELETE.
 */
function parseHostLeaseRequest(value: unknown): AllocateLeaseRequest {
  const body = readHostLeaseBody(value);
  parseMacOsAppLeaseKey(readString(body, 'deviceKey'));
  return {
    tenantId: readString(body, 'tenantId') ?? '',
    runId: readString(body, 'runId') ?? '',
    clientId: readString(body, 'clientId'),
    leaseBackend: 'macos-app',
    leaseProvider: readString(body, 'leaseProvider'),
    deviceKey: readString(body, 'deviceKey'),
    ttlMs: readTtlMs(body),
    retainOnClose: readRetainOnClose(body),
  };
}

function readHostLeaseBody(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new AppError('INVALID_ARGS', 'Host lease request body must be a JSON object.');
  }
  const body = value as Record<string, unknown>;
  const unknown = Object.keys(body).filter((key) => !HOST_LEASE_FIELDS.has(key));
  if (unknown.length > 0) {
    throw new AppError('INVALID_ARGS', `Unknown host lease field(s): ${unknown.join(', ')}.`);
  }
  if (body.leaseBackend !== 'macos-app') {
    throw new AppError('INVALID_ARGS', 'The host lease route allocates only macos-app leases.');
  }
  return body;
}

function readTtlMs(body: Record<string, unknown>): number | undefined {
  if (body.ttlMs === undefined || Number.isInteger(body.ttlMs))
    return body.ttlMs as number | undefined;
  throw new AppError('INVALID_ARGS', 'Host lease ttlMs must be an integer.');
}

function readRetainOnClose(body: Record<string, unknown>): boolean {
  if (body.retainOnClose === undefined) return true;
  if (typeof body.retainOnClose === 'boolean') return body.retainOnClose;
  throw new AppError('INVALID_ARGS', 'Host lease retainOnClose must be a boolean.');
}

function readString(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string')
    throw new AppError('INVALID_ARGS', `Host lease ${key} must be a string.`);
  return value;
}
