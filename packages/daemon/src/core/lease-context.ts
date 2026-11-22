import type { DaemonInvokeFn, DaemonRequest } from './daemon-request.ts';
import { getRequestExecutionDeadlineMs } from '@agent-device/host-kit/request';
import { AppError, BOUNDED_COMPOSITE_REASONS, type ReasonTable } from '@agent-device/kernel/errors';
import { INTERNAL_COMMANDS, PUBLIC_COMMANDS } from '@agent-device/command-registry/catalog';
import { resolveCommandStandaloneProjection } from '@agent-device/command-registry/registry';
import { ignoresSessionLease } from './daemon-command-registry.ts';
import { readLeaseBackend, type LeaseBackend } from '@agent-device/kernel/contracts';
import type { DeviceLease } from '@agent-device/contracts/device';
import type { RunnerLogicalLeaseContext } from '@agent-device/contracts/runner-lease-context';
import { stripUndefined } from '@agent-device/kernel/record';
import { normalizeTenantId } from '@agent-device/contracts/daemon-http';
import {
  findMissingProxyLeaseFields,
  isProxyLeaseScope,
  leaseScopeFromRequest,
  leaseScopeToRequestMeta,
  type LeaseScope,
} from '@agent-device/contracts/lease-scope';

export { findMissingProxyLeaseFields, isProxyLeaseScope };
export type { LeaseScope };

export function refuseBoundedCompositeResourceOperation(req: DaemonRequest, shape: string): never {
  const commandName = resolveCommandStandaloneProjection(req.command)?.command;
  throw new AppError('UNSUPPORTED_OPERATION', `${shape} cannot run within a bounded composite`, {
    reason: BOUNDED_COMPOSITE_REASONS.resourceUnsupported.reason,
    shape,
    ...(commandName ? { standaloneCommandName: commandName } : {}),
    hint: `Run the original ${commandName ?? 'refused'} operation separately with its original arguments and options, the same --session value, and the same private CLI context. Inspect completed steps before retrying the batch or replay.`,
    dispatched: 'no',
  });
}

export function isBoundedCompositeRequest(req: DaemonRequest): boolean {
  if (getRequestExecutionDeadlineMs(req.meta?.requestId) === undefined) return false;
  if (
    req.command === INTERNAL_COMMANDS.installSource ||
    req.command === PUBLIC_COMMANDS.installFromSource
  ) {
    return req.internal?.executionPlan !== undefined || req.internal?.replayPlanStep === true;
  }
  return true;
}

export type SessionLease = {
  tenantId: string;
  runId: string;
  leaseId: string;
  leaseBackend?: LeaseBackend;
  leaseProvider?: string;
  deviceKey?: string;
  clientId?: string;
  expiresAt?: number;
};

/** The `error.details.reason` values a session-lease refusal publishes. */
const LEASE_ADMISSION_REASONS = {
  // The lease scope of the request differs from the lease of its session; `details.field` names the
  // field.
  sessionMismatch: { reason: 'LEASE_SESSION_MISMATCH' },
} as const satisfies ReasonTable<'leases'>;

type SessionLeaseHolder = { lease?: SessionLease | null };

export function resolveLeaseScope(req: Pick<DaemonRequest, 'flags' | 'meta'>): LeaseScope {
  return leaseScopeFromRequest(req);
}

export function buildSessionLeaseFromRequest(
  req: Pick<DaemonRequest, 'flags' | 'meta'>,
  activeLease?: DeviceLease,
): SessionLease | undefined {
  const leaseScope = resolveLeaseScope(req);
  const leaseId = leaseScope.leaseId ?? activeLease?.leaseId;
  const tenantId = leaseScope.tenantId ?? activeLease?.tenantId;
  const runId = leaseScope.runId ?? activeLease?.runId;
  if (!tenantId || !runId || !leaseId) {
    return undefined;
  }
  return stripUndefined({
    tenantId,
    runId,
    leaseId,
    leaseBackend: leaseScope.leaseBackend ?? activeLease?.backend,
    leaseProvider: leaseScope.leaseProvider ?? activeLease?.leaseProvider,
    deviceKey: leaseScope.deviceKey ?? activeLease?.deviceKey,
    clientId: leaseScope.clientId ?? activeLease?.clientId,
    expiresAt: activeLease?.expiresAt,
  });
}

/**
 * The lease scope a request acts under on its session. A session that holds a lease admits only a
 * request that presents that lease's id: the lease id is the credential. Tenant, run, backend,
 * provider, client and device key are labels. A label must match when present, and it never grants access
 * (ADR 0007). A command that ignores the session lease acts under its own request scope.
 */
export function resolveSessionLeaseScope(
  req: Pick<DaemonRequest, 'command' | 'flags' | 'meta'>,
  session?: SessionLeaseHolder | null,
): LeaseScope {
  const requestScope = resolveLeaseScope(req);
  const sessionLease = assertRequestHoldsSessionLease(req, session);
  if (!sessionLease) return requestScope;
  return stripUndefined({
    tenantId: sessionLease.tenantId,
    runId: sessionLease.runId,
    leaseId: sessionLease.leaseId,
    leaseTtlMs: requestScope.leaseTtlMs,
    leaseBackend: sessionLease.leaseBackend ?? requestScope.leaseBackend,
    leaseProvider: sessionLease.leaseProvider,
    deviceKey: sessionLease.deviceKey,
    clientId: sessionLease.clientId,
  });
}

/**
 * A request the daemon builds inside an admitted request acts for the same caller, so it carries the
 * lease scope that the parent presented. A field the nested request names, in its meta or its
 * flags, is kept, so a step that names another lease id is still refused.
 */
export function handDownRequestLeaseScope(
  invoke: DaemonInvokeFn,
  parent: Pick<DaemonRequest, 'flags' | 'meta'>,
): DaemonInvokeFn {
  const parentScope = resolveLeaseScope(parent);
  return async (req) => {
    const childScope = resolveLeaseScope(req);
    const missing = Object.fromEntries(
      Object.entries(parentScope).filter(
        ([key]) => childScope[key as keyof LeaseScope] === undefined,
      ),
    ) as LeaseScope;
    return await invoke({ ...req, meta: { ...leaseScopeToRequestMeta(missing), ...req.meta } });
  };
}

/**
 * The lease scope a refusal reads: the request scope, completed from the session lease. Use it only
 * to refuse a request. Admission reads {@link resolveSessionLeaseScope}.
 */
export function resolveLeaseRefusalScope(
  req: Pick<DaemonRequest, 'flags' | 'meta'>,
  session?: SessionLeaseHolder | null,
): LeaseScope {
  const requestScope = resolveLeaseScope(req);
  const sessionLease = session?.lease ?? undefined;
  return stripUndefined({
    ...requestScope,
    leaseId: requestScope.leaseId ?? sessionLease?.leaseId,
    leaseBackend: requestScope.leaseBackend ?? sessionLease?.leaseBackend,
    leaseProvider: requestScope.leaseProvider ?? sessionLease?.leaseProvider,
  });
}

/**
 * Refuses a request on a leased session that does not send that lease's id, or sends a label that
 * differs from the lease. Returns the session lease the request may act under.
 */
export function assertRequestHoldsSessionLease(
  req: Pick<DaemonRequest, 'command' | 'flags' | 'meta'>,
  session?: SessionLeaseHolder | null,
): SessionLease | undefined {
  const sessionLease = ignoresSessionLease(req.command) ? undefined : session?.lease;
  if (!sessionLease) return undefined;
  assertRequestPresentsLease(resolveLeaseScope(req), sessionLease);
  // Meta wins the request scope (HTTP intake may attest the tenant, and a batch step inherits the
  // batch's meta), so a lease field sent in flags, such as a batch step's, is compared on its own.
  assertSuppliedLeaseLabels(resolveLeaseScope({ flags: req.flags }), sessionLease);
  return sessionLease;
}

/** Refuses a request that does not send `leaseId`, the credential of the lease it acts on. */
function assertRequestSendsLeaseId(requestScope: LeaseScope, leaseId: string): void {
  if (!requestScope.leaseId) {
    throw new AppError('UNAUTHORIZED', 'This session holds a device lease. Send its lease id.', {
      reason: LEASE_ADMISSION_REASONS.sessionMismatch.reason,
      field: 'leaseId',
      hint: 'Send the leaseId that the allocation returned (meta.leaseId or the leaseId param). From the CLI, open the session through connect proxy or connect --remote-config and keep the same --session; raw --tenant and --session flags do not send it.',
    });
  }
  assertMatchingLeaseId(requestScope.leaseId, leaseId);
}

function assertMatchingLeaseId(requestValue: string | undefined, leaseId: string): void {
  if (requestValue === undefined) return;
  const requested = canonicalLeaseId(requestValue);
  if (requested !== undefined && requested === canonicalLeaseId(leaseId)) return;
  throw leaseFieldMismatchError('leaseId');
}

/** A lease id is 16 to 128 hex digits; case and surrounding space do not change it. */
function canonicalLeaseId(raw: string | undefined): string | undefined {
  const value = (raw ?? '').trim();
  return /^[a-f0-9]{16,128}$/i.test(value) ? value.toLowerCase() : undefined;
}

/**
 * Refuses a request that does not send the lease's id, or sends a label that differs from the
 * lease. A label the lease does not carry differs from any value the request sends, and so does an
 * empty label.
 */
export function assertRequestPresentsLease(
  requestScope: LeaseScope,
  lease: Omit<SessionLease, 'expiresAt'>,
): void {
  assertRequestSendsLeaseId(requestScope, lease.leaseId);
  assertSuppliedLeaseLabels(requestScope, lease);
}

/** Compares each lease field the scope names with the lease; a field it omits is not compared. */
function assertSuppliedLeaseLabels(
  requestScope: LeaseScope,
  lease: Omit<SessionLease, 'expiresAt'>,
): void {
  assertMatchingLeaseId(requestScope.leaseId, lease.leaseId);
  assertMatchingTenant(requestScope.tenantId, lease.tenantId);
  assertMatchingLeaseBackend(requestScope.leaseBackend, lease.leaseBackend);
  assertMatchingLeaseField('runId', requestScope.runId, lease.runId);
  assertMatchingLeaseField('leaseProvider', requestScope.leaseProvider, lease.leaseProvider);
  assertMatchingLeaseField('clientId', requestScope.clientId, lease.clientId);
  assertMatchingLeaseField('deviceKey', requestScope.deviceKey, lease.deviceKey);
}

/**
 * Refuses a tenant that does not name the expected tenant once both are normalized. An empty or
 * malformed tenant names none, so it differs.
 */
function assertMatchingTenant(requestValue?: string, expectedValue?: string): void {
  if (requestValue === undefined) return;
  const requested = normalizeTenantId(requestValue);
  if (requested !== undefined && requested === normalizeTenantId(expectedValue)) return;
  throw leaseFieldMismatchError('tenantId');
}

function assertMatchingLeaseBackend(requestValue?: string, leaseValue?: string) {
  if (requestValue === undefined) return;
  const requested = readLeaseBackend(requestValue);
  if (requested !== undefined && requested === readLeaseBackend(leaseValue)) return;
  throw leaseFieldMismatchError('leaseBackend');
}

/** An omitted label is not compared; an empty one differs from the lease. */
function assertMatchingLeaseField(field: string, requestValue?: string, leaseValue?: string) {
  if (requestValue === undefined || requestValue === leaseValue) return;
  throw leaseFieldMismatchError(field);
}

function leaseFieldMismatchError(field: string): AppError {
  return new AppError('UNAUTHORIZED', `Lease does not match session owner (${field})`, {
    reason: LEASE_ADMISSION_REASONS.sessionMismatch.reason,
    field,
  });
}

export function resolveRunnerLogicalLeaseContext(
  req: Pick<DaemonRequest, 'meta'>,
): RunnerLogicalLeaseContext | undefined {
  const meta = req.meta as (DaemonRequest['meta'] & Record<string, unknown>) | undefined;
  const context = stripUndefined({
    leaseId: readNonEmptyString(meta?.leaseId),
    clientId: readNonEmptyString(meta?.clientId),
    tenantId: readNonEmptyString(meta?.tenantId),
    runId: readNonEmptyString(meta?.runId),
    leaseProvider: readNonEmptyString(meta?.leaseProvider),
    deviceKey: readNonEmptyString(meta?.deviceKey),
  });
  return Object.keys(context).length > 0 ? context : undefined;
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}
