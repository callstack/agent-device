import { AppError } from '../utils/errors.ts';
import { normalizeTenantId, resolveSessionIsolationMode } from './config.ts';
import { isLeaseAdmissionExempt } from './daemon-command-registry.ts';
import {
  DEFAULT_PROXY_LEASE_TTL_MS,
  findMissingProxyLeaseFields,
  isProxyLeaseScope,
  resolveLeaseScope,
  resolveRequestOrSessionLeaseScope,
} from './lease-context.ts';
import type { DeviceLease, LeaseRegistry } from './lease-registry.ts';
import type { DaemonRequest, SessionState } from './types.ts';

export function scopeRequestSession(req: DaemonRequest): DaemonRequest {
  const isolation = resolveSessionIsolationMode(
    req.meta?.sessionIsolation ?? req.flags?.sessionIsolation,
  );
  const rawTenant = req.meta?.tenantId ?? req.flags?.tenant;
  const tenant = normalizeTenantId(rawTenant);

  if (rawTenant && !tenant) {
    throw new AppError(
      'INVALID_ARGS',
      'Invalid tenant id. Use 1-128 chars: letters, numbers, dot, underscore, hyphen.',
    );
  }
  if (isolation !== 'tenant') {
    return req;
  }
  if (!tenant) {
    throw new AppError(
      'INVALID_ARGS',
      'session isolation mode tenant requires --tenant (or meta.tenantId).',
    );
  }
  const requestedSession = req.session || 'default';
  if (requestedSession.startsWith(`${tenant}:`)) {
    return {
      ...req,
      meta: {
        ...req.meta,
        tenantId: tenant,
        sessionIsolation: isolation,
      },
    };
  }
  return {
    ...req,
    session: `${tenant}:${requestedSession}`,
    meta: {
      ...req.meta,
      tenantId: tenant,
      sessionIsolation: isolation,
    },
  };
}

export function assertRequestLeaseAdmission(
  req: DaemonRequest,
  leaseRegistry: LeaseRegistry,
  session?: SessionState,
): DeviceLease | undefined {
  if (isLeaseAdmissionExempt(req.command)) {
    return undefined;
  }
  const requestLeaseScope = resolveLeaseScope(req);
  assertProxyOpenLeaseMetadata(req, requestLeaseScope);
  const sessionLease = session?.lease;
  if (!sessionLease && req.meta?.sessionIsolation !== 'tenant' && !requestLeaseScope.leaseId) {
    return undefined;
  }
  assertRequestSessionLeaseMatches(requestLeaseScope, sessionLease);
  const leaseScope = resolveRequestOrSessionLeaseScope(req, session);
  leaseRegistry.assertLeaseAdmission({
    tenantId: leaseScope.tenantId,
    runId: leaseScope.runId,
    leaseId: leaseScope.leaseId,
    backend: leaseScope.leaseBackend,
    leaseProvider: leaseScope.leaseProvider,
    deviceKey: leaseScope.deviceKey,
    clientId: leaseScope.clientId,
  });
  return leaseRegistry.heartbeatLease({
    leaseId: leaseScope.leaseId ?? '',
    tenantId: leaseScope.tenantId,
    runId: leaseScope.runId,
    backend: leaseScope.leaseBackend,
    leaseProvider: leaseScope.leaseProvider,
    deviceKey: leaseScope.deviceKey,
    clientId: leaseScope.clientId,
    ttlMs:
      leaseScope.leaseTtlMs ??
      (isProxyLeaseScope(leaseScope) ? DEFAULT_PROXY_LEASE_TTL_MS : undefined),
  });
}

export function assertRequestLeaseAdmissionPreflight(req: DaemonRequest): void {
  if (isLeaseAdmissionExempt(req.command)) return;
  assertProxyOpenLeaseMetadata(req, resolveLeaseScope(req));
}

function assertProxyOpenLeaseMetadata(
  req: DaemonRequest,
  requestLeaseScope: ReturnType<typeof resolveLeaseScope>,
): void {
  if (req.command !== 'open') return;
  const missing = findMissingProxyLeaseFields(requestLeaseScope);
  if (missing.length === 0) return;
  throw new AppError(
    'INVALID_ARGS',
    'Proxy open requires leaseId, tenantId, runId, clientId, and deviceKey lease metadata.',
    { missing },
  );
}

function assertRequestSessionLeaseMatches(
  requestLeaseScope: ReturnType<typeof resolveLeaseScope>,
  sessionLease: SessionState['lease'] | undefined,
): void {
  if (!sessionLease) return;
  assertMatchingLeaseField('leaseId', requestLeaseScope.leaseId, sessionLease.leaseId);
  assertMatchingLeaseField('tenantId', requestLeaseScope.tenantId, sessionLease.tenantId);
  assertMatchingLeaseField('runId', requestLeaseScope.runId, sessionLease.runId);
  assertMatchingLeaseField(
    'leaseProvider',
    requestLeaseScope.leaseProvider,
    sessionLease.leaseProvider,
  );
  assertMatchingLeaseField('clientId', requestLeaseScope.clientId, sessionLease.clientId);
  assertMatchingLeaseField('deviceKey', requestLeaseScope.deviceKey, sessionLease.deviceKey);
}

function assertMatchingLeaseField(
  field: string,
  requestValue?: string,
  sessionValue?: string,
): void {
  if (!requestValue || !sessionValue || requestValue === sessionValue) return;
  throw new AppError('UNAUTHORIZED', `Lease does not match session owner (${field})`, {
    reason: 'LEASE_SESSION_MISMATCH',
    field,
  });
}
