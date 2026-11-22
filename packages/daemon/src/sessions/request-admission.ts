import type { HostEnvironment } from '@agent-device/kernel/source-value';
import { AppError } from '@agent-device/kernel/errors';
import { isTenantOwnedSessionName, normalizeTenantId } from '@agent-device/contracts/daemon-http';
import { resolveSessionIsolationMode } from '../core/config.ts';
import { tenantScopedSessionName } from '../core/session-tenant-scope.ts';
import {
  isAppLeaseAllowed,
  ignoresSessionLease,
  isLeaseAdmissionExempt,
  isHumanControlMutation,
  resolveSessionlessLeaseAdmissionExemption,
} from '../core/daemon-command-registry.ts';
import type { DeviceLease, ProviderAppCatalog } from '@agent-device/contracts/device';
import {
  assertRequestHoldsSessionLease,
  findMissingProxyLeaseFields,
  resolveLeaseRefusalScope,
  resolveLeaseScope,
  resolveSessionLeaseScope,
} from '../core/lease-context.ts';
import {
  leaseScopeToHeartbeatRequest,
  remoteSessionRequiredError,
} from '@agent-device/contracts/lease-scope';
import type { LeaseRegistry } from '../resources/lease-registry.ts';
import type { DaemonRequest } from '../core/daemon-request.ts';
import type { SessionState } from '../core/session-state.ts';
import { assertMacOsAppLeaseAdmitsRequest } from '../resources/macos-app-lease.ts';
import { assertDaemonPolicyAdmitsLease } from '../core/daemon-policy.ts';
import type { DaemonPolicy } from '@agent-device/daemon-contracts/daemon-policy-file';

/** Names the session a request runs in. */
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
  session: SessionState | undefined,
  options: Readonly<{
    env: HostEnvironment['env'];
    providerAppCatalog?: ProviderAppCatalog;
    daemonPolicy?: DaemonPolicy;
  }>,
): DeviceLease | undefined {
  // An admission-exempt command still acts on its session, so it must hold the session lease too.
  assertRequestHoldsSessionLease(req, session);
  if (isExemptFromLeaseAdmission(req, leaseRegistry, session, options.daemonPolicy)) {
    return undefined;
  }
  const requestLeaseScope = resolveLeaseScope(req);
  const sessionLease = session?.lease;
  if (!sessionLease) assertProxyOpenLeaseMetadata(req, requestLeaseScope);
  if (options.daemonPolicy?.requiredLeaseBackend) {
    const leased = Boolean(resolveSessionLeaseScope(req, session).leaseId);
    const lease = leased ? admitLease(req, leaseRegistry, session, options.env) : undefined;
    assertDaemonPolicyAdmitsLease(options.daemonPolicy, lease);
    return lease;
  }
  if (
    session === undefined &&
    !requestLeaseScope.leaseId &&
    hasSessionlessLeaseAdmissionExemption(req, options.providerAppCatalog)
  ) {
    return undefined;
  }
  if (runsWithoutLease(req, sessionLease, requestLeaseScope)) return undefined;
  return admitLease(req, leaseRegistry, session, options.env);
}

/**
 * A request outside a leased session and outside tenant isolation runs without a lease unless it
 * names a scoped lease. Takeover always needs one.
 */
function runsWithoutLease(
  req: DaemonRequest,
  sessionLease: SessionState['lease'],
  requestLeaseScope: ReturnType<typeof resolveLeaseScope>,
): boolean {
  if (req.command === 'human_control') {
    if (sessionLease || requestLeaseScope.leaseId) return false;
    throw new AppError(
      'UNSUPPORTED_OPERATION',
      'Takeover requires an active remote device lease. Local takeover is not supported.',
    );
  }
  if (sessionLease || req.meta?.sessionIsolation === 'tenant') return false;
  return !requestLeaseScope.leaseId || (!requestLeaseScope.tenantId && !requestLeaseScope.runId);
}

function admitLease(
  req: DaemonRequest,
  leaseRegistry: LeaseRegistry,
  session: SessionState | undefined,
  env: HostEnvironment['env'],
): DeviceLease {
  const leaseScope = resolveSessionLeaseScope(req, session);
  leaseRegistry.assertLeaseAdmission(leaseScopeToHeartbeatRequest(leaseScope));
  // Admission renews for the window the lease already carries, or the window this request named.
  // Naming a proxy-specific default here used to shorten every lease allocated above it — a client
  // that rented a device for longer than the default lost it on the next admitted command (#2946).
  const lease = leaseRegistry.heartbeatLease(leaseScopeToHeartbeatRequest(leaseScope));
  assertMacOsAppLeaseAdmitsRequest(lease, req, session, env);
  if (isHumanControlMutation(req)) leaseRegistry.assertHumanControlAdmission(lease);
  return lease;
}

/**
 * A daemon that requires a lease, or a request in a `macos-app` lease's scope, admits only the
 * commands that opt into app leases; a lease-admission exemption does not carry past it.
 */
function isExemptFromLeaseAdmission(
  req: DaemonRequest,
  leaseRegistry: LeaseRegistry,
  session: SessionState | undefined,
  daemonPolicy: DaemonPolicy | undefined,
): boolean {
  if (!isLeaseAdmissionExempt(req.command)) return false;
  if (isAppLeaseAllowed(req.command)) return true;
  return !isConfinedToAppLease(req, leaseRegistry, session, daemonPolicy);
}

export function isConfinedToAppLease(
  req: DaemonRequest,
  leaseRegistry: LeaseRegistry,
  session: SessionState | undefined,
  daemonPolicy: DaemonPolicy | undefined,
): boolean {
  if (daemonPolicy?.requiredLeaseBackend) return true;
  const scope = resolveLeaseRefusalScope(req, session);
  if (scope.leaseBackend === 'macos-app') return true;
  return (
    scope.leaseId !== undefined && leaseRegistry.inspectLeaseBackend(scope.leaseId) === 'macos-app'
  );
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

/**
 * An unnamed session resolves to whichever connection holds the default name, so a request that
 * would allocate, use or release a provider lease has to name the session it means. Naming a
 * provider alone is not that: a sessionless catalog read holds no lease. A request that names only
 * a lease id passes here too, because the registry's owner scope refuses it for omitting the
 * provider.
 */
export function assertProviderLeaseRequestNamesSession(
  req: DaemonRequest,
  session: SessionState | undefined,
): void {
  if (!req.internal?.sessionOmitted) return;
  const { leaseProvider, leaseId } = ignoresSessionLease(req.command)
    ? resolveLeaseScope(req)
    : resolveLeaseRefusalScope(req, session);
  if (!leaseProvider) return;
  if (leaseId || req.command === 'lease_allocate') throw remoteSessionRequiredError(leaseProvider);
}

/**
 * A fresh proxy open must name the full lease metadata. A request on a session that already holds a
 * lease skips this: admission checks its lease id under the session lock instead.
 */
export function assertRequestLeaseAdmissionPreflight(
  req: DaemonRequest,
  session: SessionState | undefined,
): void {
  if (isLeaseAdmissionExempt(req.command) || session?.lease) return;
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
