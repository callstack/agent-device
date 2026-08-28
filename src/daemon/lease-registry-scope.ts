import crypto from 'node:crypto';
import type { DeviceLease } from '@agent-device/contracts/device';
import type { LeaseBackend } from '@agent-device/kernel/contracts';
import { AppError } from '@agent-device/kernel/errors';
import { normalizeTenantId } from './config.ts';

export type LeaseRegistryOptions = {
  maxActiveSimulatorLeases?: number;
  defaultLeaseTtlMs?: number;
  minLeaseTtlMs?: number;
  maxLeaseTtlMs?: number;
  providerSessionRetentionMs?: number;
  now?: () => number;
  onLeaseExpired?: (lease: DeviceLease) => void;
};

export type AllocateLeaseRequest = {
  tenantId: string;
  runId: string;
  leaseBackend?: LeaseBackend;
  leaseProvider?: string;
  deviceKey?: string;
  clientId?: string;
  ttlMs?: number;
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
};

const DEFAULT_LEASE_TTL_MS = 60_000;
const MIN_LEASE_TTL_MS = 5_000;
const MAX_LEASE_TTL_MS = 10 * 60_000;
const DEFAULT_LEASE_PROVIDER = 'default';

export function createLeaseTtlResolver(options: LeaseRegistryOptions) {
  const defaultTtl = Number.isInteger(options.defaultLeaseTtlMs)
    ? Math.max(1, Number(options.defaultLeaseTtlMs))
    : DEFAULT_LEASE_TTL_MS;
  const minTtl = Number.isInteger(options.minLeaseTtlMs)
    ? Math.max(1, Number(options.minLeaseTtlMs))
    : MIN_LEASE_TTL_MS;
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

function normalizeRunId(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const value = raw.trim();
  if (!value) return undefined;
  if (!/^[a-zA-Z0-9._-]{1,128}$/.test(value)) return undefined;
  return value;
}

export function normalizeLeaseId(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const value = raw.trim();
  if (!value) return undefined;
  if (!/^[a-f0-9]{16,128}$/i.test(value)) return undefined;
  return value.toLowerCase();
}

export function normalizeRequiredLeaseId(raw: string | undefined): string {
  const leaseId = normalizeLeaseId(raw);
  if (!leaseId) throw new AppError('INVALID_ARGS', 'Invalid lease id.');
  return leaseId;
}

export function normalizeLeaseBackend(raw: string | undefined): LeaseBackend {
  const value = (raw ?? '').trim().toLowerCase();
  if (!value || value === 'ios-simulator') return 'ios-simulator';
  if (value === 'ios-instance' || value === 'android-instance') return value;
  throw new AppError('INVALID_ARGS', `Unsupported lease backend: ${raw ?? ''}`);
}

export function normalizeDeviceKey(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const value = raw.trim();
  if (!value || value.length > 256 || !/^[\u0020-\u007E]+$/.test(value)) {
    throw new AppError('INVALID_ARGS', 'Invalid device key. Use 1-256 printable characters.');
  }
  return value;
}

function normalizeClientId(raw: string | undefined): string | undefined {
  return normalizeAgentIdentifier(raw, 'client id', 128);
}

export function normalizeLeaseProvider(raw: string | undefined): string | undefined {
  return normalizeAgentIdentifier(raw, 'lease provider', 64);
}

function normalizeAgentIdentifier(
  raw: string | undefined,
  label: string,
  maxLength: number,
): string | undefined {
  if (raw === undefined) return undefined;
  const value = raw.trim();
  if (!value || value.length > maxLength || !/^[a-zA-Z0-9._-]+$/.test(value)) {
    throw new AppError(
      'INVALID_ARGS',
      `Invalid ${label}. Use 1-${String(maxLength)} chars: letters, numbers, dot, underscore, hyphen.`,
    );
  }
  return value;
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
      reason: 'LEASE_SCOPE_MISMATCH',
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
  if (!leaseId) throw new AppError('INVALID_ARGS', 'tenant isolation requires lease id.');
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
      reason: 'LEASE_SCOPE_REQUIRED',
    });
  }
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
): DeviceLease {
  return {
    leaseId: crypto.randomBytes(16).toString('hex'),
    tenantId: request.tenantId,
    runId: request.runId,
    backend: request.backend,
    ...(request.leaseProvider ? { leaseProvider: request.leaseProvider } : {}),
    ...(request.deviceKey ? { deviceKey: request.deviceKey } : {}),
    ...(request.clientId ? { clientId: request.clientId } : {}),
    createdAt: now,
    heartbeatAt: now,
    expiresAt: now + leaseTtlMs,
  };
}

export function deviceLeaseBusyError(activeLease: DeviceLease): AppError {
  return new AppError('DEVICE_IN_USE', 'Device is already leased', {
    reason: 'DEVICE_LEASE_BUSY',
    deviceKey: activeLease.deviceKey,
    backend: activeLease.backend,
    leaseProvider: activeLease.leaseProvider,
    expiresAt: activeLease.expiresAt,
    hint: 'Retry after the lease expires or close the owning session.',
  });
}
