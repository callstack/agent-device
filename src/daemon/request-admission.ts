import { AppError } from '@agent-device/kernel/errors';
import { normalizeTenantId, resolveSessionIsolationMode } from './config.ts';
import { isTenantOwnedSessionName, tenantScopedSessionName } from './session-tenant-scope.ts';
import {
  isLeaseAdmissionExempt,
  isHumanControlMutation,
  resolveSessionlessLeaseAdmissionExemption,
} from './daemon-command-registry.ts';
import type { DeviceLease, ProviderAppCatalog } from '@agent-device/contracts/device';
import {
  findMissingProxyLeaseFields,
  resolveLeaseScope,
  resolveRequestOrSessionLeaseScope,
} from './lease-context.ts';
import { leaseScopeToHeartbeatRequest } from '@agent-device/contracts/lease-scope';
import type { LeaseRegistry } from './lease-registry.ts';
import type { DaemonRequest } from './daemon-request.ts';
import type { SessionState } from './session-state.ts';

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
  if (isTenantOwnedSessionName(tenant, requestedSession)) {
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
    session: tenantScopedSessionName(tenant, requestedSession),
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
  options: Readonly<{ providerAppCatalog?: ProviderAppCatalog }> = {},
): DeviceLease | undefined {
  if (isLeaseAdmissionExempt(req.command)) {
    return undefined;
  }
  const requestLeaseScope = resolveLeaseScope(req);
  assertProxyOpenLeaseMetadata(req, requestLeaseScope);
  const sessionLease = session?.lease;
  if (
    session === undefined &&
    !requestLeaseScope.leaseId &&
    hasSessionlessLeaseAdmissionExemption(req, options.providerAppCatalog)
  ) {
    return undefined;
  }
  if (req.command === 'human_control' && !sessionLease && !requestLeaseScope.leaseId) {
    throw new AppError(
      'UNSUPPORTED_OPERATION',
      'Takeover requires an active remote device lease. Local takeover is not supported.',
    );
  }
  if (req.command !== 'human_control' && !sessionLease && req.meta?.sessionIsolation !== 'tenant') {
    if (!requestLeaseScope.leaseId) return undefined;
    if (!requestLeaseScope.tenantId && !requestLeaseScope.runId) return undefined;
  }
  assertRequestSessionLeaseMatches(requestLeaseScope, sessionLease);
  const leaseScope = resolveRequestOrSessionLeaseScope(req, session);
  leaseRegistry.assertLeaseAdmission(leaseScopeToHeartbeatRequest(leaseScope));
  // Admission renews for the window the lease already carries, or the window this request named.
  // Naming a proxy-specific default here used to shorten every lease allocated above it — a client
  // that rented a device for longer than the default lost it on the next admitted command (#2946).
  const lease = leaseRegistry.heartbeatLease(leaseScopeToHeartbeatRequest(leaseScope));
  if (isHumanControlMutation(req)) leaseRegistry.assertHumanControlAdmission(lease);
  return lease;
}

function hasSessionlessLeaseAdmissionExemption(
  req: DaemonRequest,
  providerAppCatalog: ProviderAppCatalog | undefined,
): boolean {
  const exemption = resolveSessionlessLeaseAdmissionExemption(req);
  if (exemption?.kind === 'unconditional') return true;
  return (
    exemption?.kind === 'provider-app-catalog' &&
    providerAppCatalog?.supports(exemption.provider) === true
  );
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
