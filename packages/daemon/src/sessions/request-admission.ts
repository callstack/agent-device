import type { HostEnvironment } from '@agent-device/kernel/source-value';
import { AppError } from '@agent-device/kernel/errors';
import { readLeaseProvider } from '@agent-device/kernel/contracts';
import type { PluginInventoryEntry } from '@agent-device/contracts/plugin-inventory';
import { isTenantOwnedSessionName, normalizeTenantId } from '@agent-device/contracts/daemon-http';
import { resolveSessionIsolationMode } from '../core/config.ts';
import { tenantScopedSessionName } from '../core/session-tenant-scope.ts';
import {
  getSessionCommandKind,
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
  withDisplacedLeaseClaims,
} from '../core/lease-context.ts';
import {
  leaseScopeToHeartbeatRequest,
  remoteSessionRequiredError,
} from '@agent-device/contracts/lease-scope';
import type { LeaseRegistry } from '../resources/lease-registry.ts';
import type { DaemonRequest } from '../core/daemon-request.ts';
import type { SessionRef, SessionState } from '../core/session-state.ts';
import type { SessionStore } from '../core/session-store.ts';
import { assertMacOsAppLeaseAdmitsRequest } from '../resources/macos-app-lease.ts';
import { assertDaemonPolicyAdmitsLease } from '../core/daemon-policy.ts';
import type { DaemonPolicy } from '@agent-device/daemon-contracts/daemon-policy-file';
import {
  createSessionVisibilityPredicate,
  resolveEffectiveSessionName,
} from './session-routing.ts';

/**
 * Under tenant isolation, the first string carrier routes the request. A meta tenant that it
 * replaces stays a lease claim.
 */
export function scopeRequestSession(req: DaemonRequest): DaemonRequest {
  const isolation = resolveSessionIsolationMode(
    req.meta?.sessionIsolation ?? req.flags?.sessionIsolation,
  );
  if (isolation !== 'tenant') return req;
  const declaredTenant: unknown = req.meta?.tenantId;
  const tenant = requireWellFormedTenant(
    typeof declaredTenant === 'string' ? declaredTenant : req.flags?.tenant,
  );
  if (!tenant) throw missingIsolatedTenantError();
  const requestedSession = req.session || 'default';
  return withDisplacedLeaseClaims(
    {
      ...req,
      session: isTenantOwnedSessionName(tenant, requestedSession)
        ? req.session
        : tenantScopedSessionName(tenant, requestedSession),
      meta: { ...req.meta, tenantId: tenant, sessionIsolation: isolation },
    },
    { tenantId: [declaredTenant].filter((declared) => declared !== tenant) },
  );
}

function requireWellFormedTenant(
  rawTenant: unknown,
  beforeRefusal?: () => void,
): string | undefined {
  const tenant = normalizeTenantId(rawTenant);
  if (rawTenant && !tenant) {
    beforeRefusal?.();
    throw new AppError(
      'INVALID_ARGS',
      'Invalid tenant id. Use 1-128 chars: letters, numbers, dot, underscore, hyphen.',
    );
  }
  return tenant;
}

function missingIsolatedTenantError(): AppError {
  return new AppError(
    'INVALID_ARGS',
    'session isolation mode tenant requires --tenant (or meta.tenantId).',
  );
}

/** Check the original tenant selection. If it is invalid, give the session lease refusal priority. */
export function assertRequestTenantAdmission(
  unscopedReq: DaemonRequest,
  session?: SessionState,
): void {
  const { meta, flags } = unscopedReq;
  const rawTenant = meta?.tenantId ?? flags?.tenant;
  const assertLease = () => {
    assertRequestHoldsSessionLease(unscopedReq, session);
  };
  if (
    !rawTenant &&
    resolveSessionIsolationMode(meta?.sessionIsolation ?? flags?.sessionIsolation) === 'tenant'
  ) {
    assertLease();
    throw missingIsolatedTenantError();
  }
  requireWellFormedTenant(rawTenant, assertLease);
}

/** If routing fails without a session, give an invalid tenant priority over the routing error. */
export function withTenantAdmissionOnRoutingError<T>(
  unscopedReq: DaemonRequest,
  resolve: () => T,
): T {
  try {
    return resolve();
  } catch (error) {
    assertRequestTenantAdmission(unscopedReq);
    throw error;
  }
}

/** Resolve the session address and validate the original tenant against that session. */
export function resolveRequestSessionName(params: {
  scopedReq: DaemonRequest;
  unscopedReq: DaemonRequest;
  sessionStore: SessionStore;
}): string {
  const { scopedReq, unscopedReq, sessionStore } = params;
  const sessionName = withTenantAdmissionOnRoutingError(unscopedReq, () =>
    resolveEffectiveSessionName(scopedReq, sessionStore, {
      // Inventory must resolve an address even when the workspace owns several implicit sessions.
      attachesToSession: getSessionCommandKind(scopedReq.command) !== 'inventory',
    }),
  );
  const ref = visibleDoctorSessionRef(scopedReq, sessionStore.lookup(sessionName));
  assertRequestTenantAdmission(unscopedReq, ref?.session);
  return sessionName;
}

export function visibleDoctorSessionRef(
  req: DaemonRequest,
  ref: SessionRef | undefined,
): SessionRef | undefined {
  if (req.command === 'doctor' && ref && !createSessionVisibilityPredicate(req)(ref.session)) {
    return undefined;
  }
  return ref;
}

/**
 * The session that a request acts through at its address. A request reaches a session that holds
 * a lease only when it sends the id of that lease. A command that ignores the session lease gets
 * no session there, so it stays detached from it.
 */
export function resolveRequestSessionRef(
  req: DaemonRequest,
  ref: SessionRef | undefined,
): SessionRef | undefined {
  if (ref?.session.lease && ignoresSessionLease(req.command)) return undefined;
  assertRequestHoldsSessionLease(req, ref?.session);
  return ref;
}

export type ResolveRequestSessionRef = typeof resolveRequestSessionRef;

type ProviderCatalogAdmission = Readonly<{
  providerAppCatalog?: ProviderAppCatalog;
  pluginInventory?: readonly PluginInventoryEntry[];
}>;

export function dormantProviderAdmissionError(
  provider: string,
  pluginInventory: readonly PluginInventoryEntry[] | undefined,
): AppError | undefined {
  for (const plugin of pluginInventory ?? []) {
    if (plugin.state === 'dormant' && plugin.provider === provider) {
      const { reason, message, hint } = plugin.dormant;
      return new AppError('INVALID_ARGS', message, { provider, reason, hint });
    }
  }
}

export function assertRequestLeaseAdmission(
  req: DaemonRequest,
  leaseRegistry: LeaseRegistry,
  session: SessionState | undefined,
  options: ProviderCatalogAdmission &
    Readonly<{
      env: HostEnvironment['env'];
      daemonPolicy?: DaemonPolicy;
      /** Runs the same rules and changes no lease: no registry sweep and no renewal. */
      inspectOnly?: boolean;
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
    const lease = leased ? admitLease(req, leaseRegistry, session, options) : undefined;
    assertDaemonPolicyAdmitsLease(options.daemonPolicy, lease);
    return lease;
  }
  if (
    session === undefined &&
    hasSessionlessLeaseAdmissionExemption(req, requestLeaseScope, leaseRegistry, options)
  ) {
    return undefined;
  }
  if (runsWithoutLease(req, sessionLease, requestLeaseScope)) return undefined;
  return admitLease(req, leaseRegistry, session, options);
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
  options: Readonly<{ env: HostEnvironment['env']; inspectOnly?: boolean }>,
): DeviceLease {
  const admission = leaseScopeToHeartbeatRequest(resolveSessionLeaseScope(req, session));
  const lease = options.inspectOnly
    ? leaseRegistry.inspectLeaseAdmission(admission)
    : renewAdmittedLease(leaseRegistry, admission);
  assertMacOsAppLeaseAdmitsRequest(lease, req, session, options.env);
  if (isHumanControlMutation(req)) leaseRegistry.assertHumanControlAdmission(lease);
  return lease;
}

function renewAdmittedLease(
  leaseRegistry: LeaseRegistry,
  admission: ReturnType<typeof leaseScopeToHeartbeatRequest>,
): DeviceLease {
  leaseRegistry.assertLeaseAdmission(admission);
  // Admission renews for the window the lease already carries, or the window this request named.
  // Naming a proxy-specific default here used to shorten every lease allocated above it — a client
  // that rented a device for longer than the default lost it on the next admitted command (#2946).
  return leaseRegistry.heartbeatLease(admission);
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
  { leaseId, leaseProvider }: ReturnType<typeof resolveLeaseScope>,
  leaseRegistry: LeaseRegistry,
  options: ProviderCatalogAdmission,
): boolean {
  const exemption = resolveSessionlessLeaseAdmissionExemption(req);
  if (exemption?.kind === 'ended-lease-output') {
    return leaseId !== undefined && leaseRegistry.inspectActiveLease(leaseId) === undefined;
  }
  if (leaseId) return false;
  if (exemption?.kind === 'unconditional') return true;
  if (exemption?.kind !== 'provider-app-catalog' || leaseProvider === undefined) return false;
  const provider = readLeaseProvider(leaseProvider);
  const dormant = provider && dormantProviderAdmissionError(provider, options.pluginInventory);
  if (dormant) throw dormant;
  return options.providerAppCatalog?.supports(leaseProvider) === true;
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
