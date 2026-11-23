import crypto from 'node:crypto';
import {
  providerInstanceUnallocatedError,
  type DeviceLease,
  type LeaseLifecycleContext,
} from '@agent-device/contracts/device';
import {
  LEASE_REASONS,
  MIN_LEASE_WINDOW_MS,
  leaseScopeToReleaseRequest,
  leaseProviderRequiringRuntime,
  normalizeLeaseId,
} from '@agent-device/contracts/lease-scope';
import {
  normalizeLeaseProvider,
  readLeaseBackend,
  type LeaseBackend,
} from '@agent-device/kernel/contracts';
import { AppError, type ReasonTable } from '@agent-device/kernel/errors';
import { normalizeTenantId } from '@agent-device/contracts/daemon-http';
import { LEASE_FIELD_NORMALIZERS, type SessionLease } from '../core/lease-context.ts';

export const DEVICE_LEASE_REASONS = {
  // Another lease, or this tenant run, already holds the device; retry after that lease is released
  // or expires.
  busy: { reason: 'DEVICE_LEASE_BUSY' },
  // The lease is ending and its local session cleanup is still pending.
  sessionCleanupPending: { reason: 'session-cleanup-pending' },
  // The provider confirmed release. Retry allocation after the daemon records that result.
  rentalRetirementPending: { reason: 'provider-rental-retirement-pending' },
} as const satisfies ReasonTable<'leases'>;

export type LeaseRegistryOptions = {
  providerRentals?: {
    assertLeaseIdAvailable: (leaseId: string) => void;
    reserve: (lease: DeviceLease) => void;
    context: (lease: DeviceLease) => LeaseLifecycleContext['rental'];
    persistPendingInstance: (lease: DeviceLease) => void;
    confirmReleased: (lease: DeviceLease) => boolean;
  };
  maxActiveSimulatorLeases?: number;
  defaultLeaseTtlMs?: number;
  minLeaseTtlMs?: number;
  maxLeaseTtlMs?: number;
  providerSessionRetentionMs?: number;
  now?: () => number;
  onLeaseExpired?: (
    lease: DeviceLease,
    reason?: 'PROVIDER_INSTANCE_ENDED' | 'LEASE_RELEASED',
  ) => void;
  /**
   * Called with every live provider lease after a provider lease is issued or leaves the registry, so
   * the daemon can journal what a crash would otherwise forget. An expired lease leaves only after
   * `onLeaseExpired` has taken it over.
   */
  onProviderLeasesChanged?: (leases: readonly DeviceLease[]) => void;
};

export type AllocateLeaseRequest = {
  tenantId: string;
  runId: string;
  /** A caller-chosen id of at least 128 random bits for a new lease; without it the registry mints one. */
  leaseId?: string;
  leaseBackend?: LeaseBackend;
  leaseProvider?: string;
  deviceKey?: string;
  clientId?: string;
  ttlMs?: number;
  retainOnClose?: boolean;
};

export type HeartbeatLeaseRequest = {
  leaseId: string;
  tenantId?: string;
  runId?: string;
  leaseBackend?: LeaseBackend;
  leaseProvider?: string;
  deviceKey?: string;
  clientId?: string;
  ttlMs?: number;
};

export type ReleaseLeaseRequest = {
  leaseId: string;
  tenantId?: string;
  runId?: string;
  leaseBackend?: LeaseBackend;
  leaseProvider?: string;
  deviceKey?: string;
  clientId?: string;
};

export type AdmissionRequest = {
  tenantId?: string;
  runId?: string;
  leaseId?: string;
  leaseBackend?: LeaseBackend;
  leaseProvider?: string;
  deviceKey?: string;
  clientId?: string;
};

type LeaseScopeMatchRequest = {
  tenantId?: string;
  runId?: string;
  leaseBackend?: LeaseBackend;
  leaseProvider?: string;
  deviceKey?: string;
  clientId?: string;
};

type NormalizedLeaseScopeMatchRequest = {
  tenantId?: string;
  runId?: string;
  leaseBackend?: LeaseBackend;
  leaseProvider?: string;
  deviceKey?: string;
  clientId?: string;
};

export type NormalizedAllocateLeaseRequest = {
  tenantId: string;
  runId: string;
  backend: LeaseBackend;
  leaseProvider?: string;
  deviceKey?: string;
  clientId?: string;
  ttlMs?: number;
  retainOnClose?: boolean;
};

const DEFAULT_LEASE_TTL_MS = 60_000;
const MAX_LEASE_TTL_MS = 10 * 60_000;
const DEFAULT_LEASE_PROVIDER = 'default';

export function createLeaseTtlResolver(options: LeaseRegistryOptions) {
  const defaultTtl = Number.isInteger(options.defaultLeaseTtlMs)
    ? Math.max(1, Number(options.defaultLeaseTtlMs))
    : DEFAULT_LEASE_TTL_MS;
  const minTtl = Number.isInteger(options.minLeaseTtlMs)
    ? Math.max(1, Number(options.minLeaseTtlMs))
    : MIN_LEASE_WINDOW_MS;
  const maxTtl = Number.isInteger(options.maxLeaseTtlMs)
    ? Math.max(minTtl, Number(options.maxLeaseTtlMs))
    : MAX_LEASE_TTL_MS;
  return (raw: number | undefined): number => {
    if (!Number.isInteger(raw)) return defaultTtl;
    const value = Number(raw);
    if (value < minTtl || value > maxTtl) {
      throw new AppError('INVALID_ARGS', `Lease ttlMs must be between ${minTtl} and ${maxTtl}.`);
    }
    return value;
  };
}

const normalizeRunId = LEASE_FIELD_NORMALIZERS.runId;

export function normalizeRequiredLeaseId(raw: string | undefined): string {
  const leaseId = normalizeLeaseId(raw);
  if (!leaseId) throw new AppError('INVALID_ARGS', 'Invalid lease id.');
  return leaseId;
}

/** 32 hex digits: the 128 bits a lease id needs to serve as the credential for its session. */
const MIN_CALLER_CHOSEN_LEASE_ID_HEX_DIGITS = 32;

/** The `error.details.reason` values a caller-chosen lease id refusal publishes. */
const CALLER_CHOSEN_LEASE_ID_REASONS = {
  // A lease id that the caller chose on allocate has fewer than 32 hex digits (128 bits).
  tooShort: { reason: 'LEASE_ID_TOO_SHORT' },
} as const satisfies ReasonTable<'leases'>;

/**
 * A caller-chosen lease id becomes the bearer credential for the lease, so an id shorter than the
 * 128 bits the daemon mints is refused.
 */
export function normalizeCallerChosenLeaseId(raw: string): string {
  const leaseId = normalizeRequiredLeaseId(raw);
  if (leaseId.length < MIN_CALLER_CHOSEN_LEASE_ID_HEX_DIGITS) {
    throw new AppError(
      'INVALID_ARGS',
      `A caller-chosen lease id needs at least ${MIN_CALLER_CHOSEN_LEASE_ID_HEX_DIGITS} random hex digits (128 bits).`,
      { reason: CALLER_CHOSEN_LEASE_ID_REASONS.tooShort.reason },
    );
  }
  return leaseId;
}

export function normalizeLeaseBackend(raw: string | undefined): LeaseBackend {
  if (!(raw ?? '').trim()) return 'ios-simulator';
  const backend = readLeaseBackend(raw);
  if (backend) return backend;
  throw new AppError('INVALID_ARGS', `Unsupported lease backend: ${raw ?? ''}`);
}

export function normalizeDeviceKey(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const value = LEASE_FIELD_NORMALIZERS.deviceKey(raw);
  if (value) return value;
  throw new AppError('INVALID_ARGS', 'Invalid device key. Use 1-256 printable characters.');
}

function normalizeClientId(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const value = LEASE_FIELD_NORMALIZERS.clientId(raw);
  if (value) return value;
  throw new AppError(
    'INVALID_ARGS',
    'Invalid client id. Use 1-128 chars: letters, numbers, dot, underscore, hyphen.',
  );
}

function normalizeRequiredTenantId(raw: string): string {
  const tenantId = normalizeTenantId(raw);
  if (!tenantId) {
    throw new AppError(
      'INVALID_ARGS',
      'Invalid tenant id. Use 1-128 chars: letters, numbers, dot, underscore, hyphen.',
    );
  }
  return tenantId;
}

function normalizeRequiredRunId(raw: string): string {
  const runId = normalizeRunId(raw);
  if (!runId) {
    throw new AppError(
      'INVALID_ARGS',
      'Invalid run id. Use 1-128 chars: letters, numbers, dot, underscore, hyphen.',
    );
  }
  return runId;
}

export function normalizeAllocateLeaseRequest(
  request: AllocateLeaseRequest,
): NormalizedAllocateLeaseRequest {
  return {
    backend: normalizeLeaseBackend(request.leaseBackend),
    leaseProvider: normalizeLeaseProvider(request.leaseProvider),
    deviceKey: normalizeDeviceKey(request.deviceKey),
    clientId: normalizeClientId(request.clientId),
    tenantId: normalizeRequiredTenantId(request.tenantId),
    runId: normalizeRequiredRunId(request.runId),
    ttlMs: request.ttlMs,
    retainOnClose: request.retainOnClose,
  };
}

function leaseRequiresOwnerScope(lease: DeviceLease): boolean {
  return Boolean(lease.leaseProvider ?? lease.deviceKey ?? lease.clientId);
}

function hasRequiredOwnerScope(lease: DeviceLease, request: LeaseScopeMatchRequest): boolean {
  if (!request.tenantId || !request.runId) return false;
  return [
    [lease.leaseProvider, request.leaseProvider],
    [lease.deviceKey, request.deviceKey],
    [lease.clientId, request.clientId],
  ].every(([leaseValue, requestValue]) => !leaseValue || Boolean(requestValue));
}

export function assertLeaseScopeMatch(
  lease: DeviceLease,
  request: HeartbeatLeaseRequest | AdmissionRequest,
): void {
  const normalized = normalizeOptionalLeaseScope(request);
  if (
    (normalized.tenantId && lease.tenantId !== normalized.tenantId) ||
    (normalized.runId && lease.runId !== normalized.runId) ||
    (normalized.leaseBackend && lease.backend !== normalized.leaseBackend) ||
    (normalized.leaseProvider && lease.leaseProvider !== normalized.leaseProvider) ||
    (normalized.deviceKey && lease.deviceKey !== normalized.deviceKey) ||
    (normalized.clientId && lease.clientId !== normalized.clientId)
  ) {
    throw new AppError('UNAUTHORIZED', 'Lease does not match tenant/run scope', {
      reason: LEASE_REASONS.scopeMismatch.reason,
    });
  }
}

export function normalizeLeaseAdmissionRequest(
  request: AdmissionRequest,
): AdmissionRequest & { leaseId: string } {
  const leaseBackend = normalizeLeaseBackend(request.leaseBackend);
  const tenantId = normalizeTenantId(request.tenantId);
  if (!tenantId) throw new AppError('INVALID_ARGS', 'tenant isolation requires tenant id.');
  const runId = normalizeRunId(request.runId);
  if (!runId) throw new AppError('INVALID_ARGS', 'tenant isolation requires run id.');
  const leaseId = normalizeLeaseId(request.leaseId);
  if (!leaseId) {
    // A provider runtime's connection that sent no lease has no instance, for example after
    // `close --shutdown` released it. Name that, as device inventory does. A malformed lease id stays
    // a missing lease id, and so does a logical lease such as `proxy`, which names a route, not an
    // instance.
    const runtimeProvider = leaseProviderRequiringRuntime({
      leaseProvider: normalizeLeaseProvider(request.leaseProvider),
    });
    if (runtimeProvider && !request.leaseId?.trim()) {
      throw providerInstanceUnallocatedError(runtimeProvider);
    }
    throw new AppError('INVALID_ARGS', 'tenant isolation requires lease id.', {
      hint: 'Allocate a lease with leases.allocate and pass its leaseId.',
    });
  }
  return { ...request, tenantId, runId, leaseId, leaseBackend };
}
function normalizeOptionalLeaseScope(
  request: LeaseScopeMatchRequest,
): NormalizedLeaseScopeMatchRequest {
  const tenantId = normalizeTenantId(request.tenantId);
  const runId = normalizeRunId(request.runId);
  if (request.tenantId && !tenantId) {
    throw new AppError(
      'INVALID_ARGS',
      'Invalid tenant id. Use 1-128 chars: letters, numbers, dot, underscore, hyphen.',
    );
  }
  if (request.runId && !runId) {
    throw new AppError(
      'INVALID_ARGS',
      'Invalid run id. Use 1-128 chars: letters, numbers, dot, underscore, hyphen.',
    );
  }
  return {
    tenantId,
    runId,
    leaseBackend: request.leaseBackend ? normalizeLeaseBackend(request.leaseBackend) : undefined,
    leaseProvider: normalizeLeaseProvider(request.leaseProvider),
    deviceKey: normalizeDeviceKey(request.deviceKey),
    clientId: normalizeClientId(request.clientId),
  };
}

export function assertLeaseOwnerScope(lease: DeviceLease, request: HeartbeatLeaseRequest): void {
  if (leaseRequiresOwnerScope(lease) && !hasRequiredOwnerScope(lease, request)) {
    throw new AppError('UNAUTHORIZED', 'Lease owner scope is required', {
      reason: LEASE_REASONS.scopeRequired.reason,
    });
  }
}

/** Whether `lease` was allocated with exactly this owner and device scope. */
export function hasAllocatedScope(
  lease: DeviceLease,
  request: NormalizedAllocateLeaseRequest,
): boolean {
  return (
    lease.tenantId === request.tenantId &&
    lease.runId === request.runId &&
    lease.backend === request.backend &&
    lease.leaseProvider === request.leaseProvider &&
    lease.deviceKey === request.deviceKey &&
    lease.clientId === request.clientId
  );
}

export function leaseDeviceBindingKey(
  scope: Pick<DeviceLease, 'backend' | 'leaseProvider' | 'deviceKey'>,
): string | undefined {
  if (!scope.deviceKey) return undefined;
  return JSON.stringify([
    scope.backend,
    scope.leaseProvider ?? DEFAULT_LEASE_PROVIDER,
    scope.deviceKey,
  ]);
}

export function leaseRunBindingKey(
  scope: Pick<DeviceLease, 'tenantId' | 'runId' | 'backend' | 'leaseProvider' | 'deviceKey'>,
): string {
  return JSON.stringify([
    scope.tenantId,
    scope.runId,
    scope.backend,
    scope.leaseProvider ?? DEFAULT_LEASE_PROVIDER,
    scope.deviceKey ?? '*',
  ]);
}

export function createDeviceLease(
  request: NormalizedAllocateLeaseRequest,
  leaseTtlMs: number,
  now: number,
  leaseId = crypto.randomBytes(16).toString('hex'),
): DeviceLease {
  return {
    leaseId,
    tenantId: request.tenantId,
    runId: request.runId,
    backend: request.backend,
    ...(request.leaseProvider ? { leaseProvider: request.leaseProvider } : {}),
    ...(request.deviceKey ? { deviceKey: request.deviceKey } : {}),
    ...(request.clientId ? { clientId: request.clientId } : {}),
    ...(request.retainOnClose ? { retainOnClose: true as const } : {}),
    createdAt: now,
    heartbeatAt: now,
    expiresAt: now + leaseTtlMs,
  };
}

/**
 * The inactivity window a lease is currently living on: whatever TTL it was last renewed for.
 *
 * Every renewal that is not asked to change the window uses this, so a renewal never quietly
 * re-decides it. Reading the registry default instead would shorten a lease allocated with a longer
 * one — and a caller that heartbeats without repeating the allocation's TTL is not asking for the
 * default, it is asking for the same lease to keep going.
 */
export function leaseOwnTtlMs(lease: Pick<DeviceLease, 'expiresAt' | 'heartbeatAt'>): number {
  return lease.expiresAt - lease.heartbeatAt;
}

export type ReleaseUnknownReason =
  | 'provider-release-unconfirmed'
  | 'provider-runtime-unavailable'
  | 'device-claim-release-unconfirmed';

export function deviceLeaseBusyError(
  activeLease?: DeviceLease,
  releaseUnknown?: ReleaseUnknownReason,
  reason: (typeof DEVICE_LEASE_REASONS)[keyof typeof DEVICE_LEASE_REASONS]['reason'] = DEVICE_LEASE_REASONS
    .busy.reason,
): AppError {
  return new AppError(
    'DEVICE_IN_USE',
    releaseUnknown
      ? 'Lease release is unknown'
      : activeLease
        ? 'Device is already leased'
        : 'Lease cleanup is pending',
    {
      reason,
      ...(activeLease
        ? {
            deviceKey: activeLease.deviceKey,
            backend: activeLease.backend,
            leaseProvider: activeLease.leaseProvider,
            expiresAt: activeLease.expiresAt,
            hint: 'Retry after the lease expires or close the owning session.',
          }
        : { dispatched: 'no' }),
      ...(releaseUnknown
        ? {
            releaseStatus: 'unknown',
            releaseReason: releaseUnknown,
            hint:
              releaseUnknown === 'device-claim-release-unconfirmed'
                ? 'Contact the daemon operator to reconcile the device claim.'
                : 'Contact the daemon operator to reconcile the provider release.',
          }
        : {}),
    },
  );
}

export function leaseReleaseRequestFor(lease: SessionLease): ReleaseLeaseRequest {
  return leaseScopeToReleaseRequest({
    leaseId: lease.leaseId,
    tenantId: lease.tenantId,
    runId: lease.runId,
    leaseBackend: lease.backend,
    leaseProvider: lease.leaseProvider,
    deviceKey: lease.deviceKey,
    clientId: lease.clientId,
  });
}
