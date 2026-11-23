import type { DaemonInvokeFn, DaemonRequest } from './daemon-request.ts';
import { getRequestExecutionDeadlineMs } from '@agent-device/host-kit/request';
import {
  AppError,
  BOUNDED_COMPOSITE_RESOURCE_UNSUPPORTED_REASON,
  type ReasonTable,
} from '@agent-device/kernel/errors';
import { INTERNAL_COMMANDS, PUBLIC_COMMANDS } from '@agent-device/command-registry/catalog';
import { resolveCommandStandaloneProjection } from '@agent-device/command-registry/registry';
import { ignoresSessionLease } from './daemon-command-registry.ts';
import { readLeaseProvider, readLeaseBackend } from '@agent-device/kernel/contracts';
import { normalizeTenantId } from '@agent-device/contracts/daemon-http';
import type { DeviceLease } from '@agent-device/contracts/device';
import type { RunnerLogicalLeaseContext } from '@agent-device/contracts/runner-lease-context';
import { stripUndefined } from '@agent-device/kernel/record';
import {
  findMissingProxyLeaseFields,
  isProxyLeaseScope,
  leaseScopeFromRequest,
  leaseScopeToRequestMeta,
  normalizeLeaseId,
  type LeaseClaims,
  type LeaseScope,
} from '@agent-device/contracts/lease-scope';

export { findMissingProxyLeaseFields, isProxyLeaseScope };
export type { LeaseScope };

export function refuseBoundedCompositeResourceOperation(req: DaemonRequest, shape: string): never {
  const commandName = resolveCommandStandaloneProjection(req.command)?.command;
  throw new AppError('UNSUPPORTED_OPERATION', `${shape} cannot run within a bounded composite`, {
    reason: BOUNDED_COMPOSITE_RESOURCE_UNSUPPORTED_REASON,
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

/** The lease a session is bound to: the id and labels of the lease that admitted its open. */
export type SessionLease = Readonly<
  Pick<
    DeviceLease,
    'leaseId' | 'tenantId' | 'runId' | 'backend' | 'leaseProvider' | 'deviceKey' | 'clientId'
  >
>;

type LeaseClaimField = keyof LeaseClaims;

type LeaseClaimRefusal = { kind: 'missing-id' } | { kind: 'mismatch'; field: LeaseClaimField };

type LeaseClaimRequest = Pick<DaemonRequest, 'flags' | 'meta' | 'internal'>;

/** The flags that carry each lease field. `meta` carries each field under the field's own name. */
const LEASE_CLAIM_FLAGS = {
  leaseId: ['leaseId'],
  tenantId: ['tenant'],
  leaseBackend: ['leaseBackend'],
  runId: ['runId'],
  leaseProvider: ['leaseProvider', 'provider'],
  clientId: ['clientId'],
  deviceKey: ['deviceKey'],
} as const satisfies Record<LeaseClaimField, readonly string[]>;

const LEASE_CLAIM_FIELDS = Object.keys(LEASE_CLAIM_FLAGS) as LeaseClaimField[];

function trimmedLeaseLabel(pattern: RegExp): (raw: unknown) => string | undefined {
  return (raw) => {
    const value = typeof raw === 'string' ? raw.trim() : '';
    return pattern.test(value) ? value : undefined;
  };
}

/**
 * The canonical value of each lease field, as the lease registry stores it. A value that names
 * none, of any type, gives `undefined`.
 */
export const LEASE_FIELD_NORMALIZERS = {
  leaseId: normalizeLeaseId,
  tenantId: normalizeTenantId,
  leaseBackend: (raw) => (typeof raw === 'string' ? readLeaseBackend(raw) : undefined),
  runId: trimmedLeaseLabel(/^[a-zA-Z0-9._-]{1,128}$/),
  leaseProvider: readLeaseProvider,
  clientId: trimmedLeaseLabel(/^[a-zA-Z0-9._-]{1,128}$/),
  deviceKey: trimmedLeaseLabel(/^[\u0020-\u007E]{1,256}$/),
} as const satisfies Record<LeaseClaimField, (raw: unknown) => string | undefined>;

/** The `error.details.reason` values a session-lease refusal publishes. */
export const LEASE_ADMISSION_REASONS = {
  // The lease scope of the request differs from the lease of its session; `details.field` names the
  // field.
  sessionMismatch: { reason: 'LEASE_SESSION_MISMATCH' },
} as const satisfies ReasonTable<'leases'>;

type SessionLeaseHolder = { lease?: SessionLease | null };

export function resolveLeaseScope(req: Pick<DaemonRequest, 'flags' | 'meta'>): LeaseScope {
  return leaseScopeFromRequest(req);
}

export function sessionLeaseOf(lease: SessionLease): SessionLease {
  return stripUndefined({
    leaseId: lease.leaseId,
    tenantId: lease.tenantId,
    runId: lease.runId,
    backend: lease.backend,
    leaseProvider: lease.leaseProvider,
    deviceKey: lease.deviceKey,
    clientId: lease.clientId,
  });
}

/**
 * The lease scope a request acts under on its session. A session that holds a lease admits only a
 * request that presents that lease's id: the lease id is the credential. Tenant, run, backend,
 * provider, client and device key are labels. A label must match when present, and it never grants access
 * (ADR 0007). A command that ignores the session lease acts under its own request scope.
 */
export function resolveSessionLeaseScope(
  req: Pick<DaemonRequest, 'command'> & LeaseClaimRequest,
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
    leaseBackend: sessionLease.backend,
    leaseProvider: sessionLease.leaseProvider,
    deviceKey: sessionLease.deviceKey,
    clientId: sessionLease.clientId,
  });
}

/**
 * Records lease labels that an intake adapter replaced or collapsed. Admission compares them with
 * the lease as it compares the labels the request still carries.
 */
export function withDisplacedLeaseClaims(
  req: DaemonRequest,
  displaced: Partial<Record<LeaseClaimField, readonly unknown[]>>,
): DaemonRequest {
  const claims = mergeLeaseClaims(req.internal?.displacedLeaseClaims, displaced);
  return claims ? { ...req, internal: { ...req.internal, displacedLeaseClaims: claims } } : req;
}

function mergeLeaseClaims(
  ...sources: (Partial<Record<LeaseClaimField, readonly unknown[]>> | undefined)[]
): LeaseClaims | undefined {
  const claims: Partial<Record<LeaseClaimField, unknown[]>> = {};
  for (const field of LEASE_CLAIM_FIELDS) {
    const values = sources.flatMap((source) => source?.[field] ?? []).filter(isSupplied);
    if (values.length > 0) claims[field] = values;
  }
  return Object.keys(claims).length > 0 ? claims : undefined;
}

/**
 * A request the daemon builds inside an admitted request acts for the same caller, so it carries the
 * lease scope that the parent presented. A field the nested request names, in its meta or its
 * flags, is kept, so a step that names another lease id is still refused. Every value the parent
 * sent that the nested request does not carry is handed down as a displaced claim.
 */
export function handDownRequestLeaseScope(
  invoke: DaemonInvokeFn,
  parent: LeaseClaimRequest,
): DaemonInvokeFn {
  const parentScope = resolveLeaseScope(parent);
  const parentClaims = readLeaseClaims(parent);
  return async (req) => {
    const childScope = resolveLeaseScope(req);
    const inherited = Object.fromEntries(
      Object.entries(parentScope).filter(
        ([key]) => childScope[key as keyof LeaseScope] === undefined,
      ),
    ) as LeaseScope;
    const child = { ...req, meta: { ...leaseScopeToRequestMeta(inherited), ...req.meta } };
    const childClaims = readLeaseClaims(child);
    const absent = Object.fromEntries(
      LEASE_CLAIM_FIELDS.map((field) => [
        field,
        parentClaims[field].filter((claim) => !childClaims[field].includes(claim)),
      ]),
    );
    return await invoke(withDisplacedLeaseClaims(child, absent));
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
    leaseBackend: requestScope.leaseBackend ?? sessionLease?.backend,
    leaseProvider: requestScope.leaseProvider ?? sessionLease?.leaseProvider,
  });
}

/**
 * Refuses a request on a leased session that does not send that lease's id, or sends a label that
 * differs from the lease. Returns the session lease the request may act under.
 */
export function assertRequestHoldsSessionLease(
  req: Pick<DaemonRequest, 'command'> & LeaseClaimRequest,
  session?: SessionLeaseHolder | null,
): SessionLease | undefined {
  const sessionLease = ignoresSessionLease(req.command) ? undefined : session?.lease;
  if (!sessionLease) return undefined;
  assertRequestPresentsLease(req, sessionLease);
  return sessionLease;
}

/**
 * Refuses a request that does not send the lease's id, or sends a label that differs from the
 * lease. Every value the request sent is compared: its meta, its flags, each alias, and each claim
 * an intake adapter displaced. A label the lease does not carry differs from any value the request
 * sends, and so does an empty label or a value that is not a string.
 */
export function assertRequestPresentsLease(req: LeaseClaimRequest, lease: SessionLease): void {
  const refusal = compareRequestLeaseClaims(req, lease);
  if (!refusal) return;
  if (refusal.kind === 'missing-id') {
    throw new AppError('UNAUTHORIZED', 'This session holds a device lease. Send its lease id.', {
      reason: LEASE_ADMISSION_REASONS.sessionMismatch.reason,
      field: 'leaseId',
      hint: 'Send the leaseId that the allocation returned (meta.leaseId or the leaseId param). From the CLI, open the session through connect proxy or connect --remote-config and keep the same --session; raw --tenant and --session flags do not send it.',
    });
  }
  throw new AppError('UNAUTHORIZED', `Lease does not match session owner (${refusal.field})`, {
    reason: LEASE_ADMISSION_REASONS.sessionMismatch.reason,
    field: refusal.field,
  });
}

/** Reports the first refusal without constructing an error. */
export function compareRequestLeaseClaims(
  req: LeaseClaimRequest,
  lease: SessionLease,
): LeaseClaimRefusal | undefined {
  const claims = readLeaseClaims(req);
  if (claims.leaseId.every((claim) => typeof claim === 'string' && !claim.trim())) {
    return { kind: 'missing-id' };
  }
  for (const field of LEASE_CLAIM_FIELDS) {
    if (!claims[field].every((claim) => leaseClaimNamesLease(field, claim, lease))) {
      return { kind: 'mismatch', field };
    }
  }
  return undefined;
}

function readLeaseClaims(req: LeaseClaimRequest): Record<LeaseClaimField, unknown[]> {
  const meta: Record<string, unknown> = req.meta ?? {};
  const flags: Record<string, unknown> = req.flags ?? {};
  const displaced = req.internal?.displacedLeaseClaims;
  return Object.fromEntries(
    LEASE_CLAIM_FIELDS.map((field) => [
      field,
      [
        meta[field],
        ...LEASE_CLAIM_FLAGS[field].map((flag) => flags[flag]),
        ...(displaced?.[field] ?? []),
      ].filter(isSupplied),
    ]),
  ) as Record<LeaseClaimField, unknown[]>;
}

/** The lease holds canonical values, so a claim names the lease once the registry normalizes it. */
function leaseClaimNamesLease(
  field: LeaseClaimField,
  claim: unknown,
  lease: SessionLease,
): boolean {
  const normalized = LEASE_FIELD_NORMALIZERS[field](claim);
  const expected = field === 'leaseBackend' ? lease.backend : lease[field];
  return normalized !== undefined && normalized === expected;
}

function isSupplied(value: unknown): boolean {
  return value !== undefined;
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
