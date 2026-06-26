import crypto from 'node:crypto';
import type { LeaseBackend } from '../contracts.ts';
import { AppError } from '../utils/errors.ts';
import { normalizeTenantId } from './config.ts';

export type DeviceLease = {
  leaseId: string;
  tenantId: string;
  runId: string;
  backend: LeaseBackend;
  leaseProvider?: string;
  deviceKey?: string;
  clientId?: string;
  createdAt: number;
  heartbeatAt: number;
  expiresAt: number;
};

export type SimulatorLease = DeviceLease;

export type LeaseRegistryOptions = {
  maxActiveSimulatorLeases?: number;
  defaultLeaseTtlMs?: number;
  minLeaseTtlMs?: number;
  maxLeaseTtlMs?: number;
  now?: () => number;
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

type NormalizedAllocateLeaseRequest = {
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

function normalizeRunId(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const value = raw.trim();
  if (!value) return undefined;
  if (!/^[a-zA-Z0-9._-]{1,128}$/.test(value)) return undefined;
  return value;
}

function normalizeLeaseId(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const value = raw.trim();
  if (!value) return undefined;
  if (!/^[a-f0-9]{16,128}$/i.test(value)) return undefined;
  return value.toLowerCase();
}

function normalizeLeaseBackend(raw: string | undefined): LeaseBackend {
  const value = (raw ?? '').trim().toLowerCase();
  if (!value || value === 'ios-simulator') return 'ios-simulator';
  if (value === 'ios-instance' || value === 'android-instance') return value;
  throw new AppError('INVALID_ARGS', `Unsupported lease backend: ${raw ?? ''}`);
}

function normalizeDeviceKey(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const value = raw.trim();
  if (!value || value.length > 256 || !/^[\x20-\x7E]+$/.test(value)) {
    throw new AppError('INVALID_ARGS', 'Invalid device key. Use 1-256 printable characters.');
  }
  return value;
}

function normalizeClientId(raw: string | undefined): string | undefined {
  return normalizeAgentIdentifier(raw, 'client id', 128);
}

function normalizeLeaseProvider(raw: string | undefined): string | undefined {
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

function normalizeAllocateLeaseRequest(
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

export class LeaseRegistry {
  private readonly leases = new Map<string, DeviceLease>();
  private readonly runBindings = new Map<string, string>();
  private readonly deviceBindings = new Map<string, string>();
  private readonly maxActiveSimulatorLeases: number;
  private readonly defaultLeaseTtlMs: number;
  private readonly minLeaseTtlMs: number;
  private readonly maxLeaseTtlMs: number;
  private readonly now: () => number;

  constructor(options: LeaseRegistryOptions = {}) {
    this.maxActiveSimulatorLeases = Number.isInteger(options.maxActiveSimulatorLeases)
      ? Math.max(0, Number(options.maxActiveSimulatorLeases))
      : 0;
    this.defaultLeaseTtlMs = Number.isInteger(options.defaultLeaseTtlMs)
      ? Math.max(1, Number(options.defaultLeaseTtlMs))
      : DEFAULT_LEASE_TTL_MS;
    this.minLeaseTtlMs = Number.isInteger(options.minLeaseTtlMs)
      ? Math.max(1, Number(options.minLeaseTtlMs))
      : MIN_LEASE_TTL_MS;
    this.maxLeaseTtlMs = Number.isInteger(options.maxLeaseTtlMs)
      ? Math.max(this.minLeaseTtlMs, Number(options.maxLeaseTtlMs))
      : MAX_LEASE_TTL_MS;
    this.now = options.now ?? (() => Date.now());
  }

  allocateLease(request: AllocateLeaseRequest): DeviceLease {
    const normalized = normalizeAllocateLeaseRequest(request);
    this.cleanupExpiredLeases();
    const leaseTtlMs = this.resolveLeaseTtlMs(normalized.ttlMs);
    const existingLease = this.refreshExistingRunBinding(normalized, leaseTtlMs);
    if (existingLease) return existingLease;
    this.assertDeviceAvailable(normalized);
    this.enforceCapacity(normalized.backend);
    const lease = this.createLease(normalized, leaseTtlMs);
    this.leases.set(lease.leaseId, lease);
    this.bindLease(lease);
    return { ...lease };
  }

  private refreshExistingRunBinding(
    request: NormalizedAllocateLeaseRequest,
    leaseTtlMs: number,
  ): DeviceLease | undefined {
    const bindingKey = this.bindingKey(request);
    const existingId = this.runBindings.get(bindingKey);
    if (!existingId) return undefined;
    const existingLease = this.leases.get(existingId);
    if (!existingLease) {
      this.runBindings.delete(bindingKey);
      return undefined;
    }
    if (this.canReuseRunBinding(existingLease, request)) {
      return this.refreshLease(existingLease, leaseTtlMs);
    }
    if (existingLease.deviceKey) {
      this.throwDeviceBusy(existingLease);
    }
    this.assertOptionalLeaseIdentityMatch(existingLease, request);
    return this.refreshLease(existingLease, leaseTtlMs);
  }

  private createLease(request: NormalizedAllocateLeaseRequest, leaseTtlMs: number): DeviceLease {
    const now = this.now();
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

  heartbeatLease(request: HeartbeatLeaseRequest): DeviceLease {
    const leaseId = this.normalizeRequiredLeaseId(request.leaseId);
    this.cleanupExpiredLeases();
    const lease = this.getActiveLease(leaseId);
    this.assertRequiredScopeForDeviceAwareLease(lease, request);
    this.assertOptionalScopeMatch(lease, request);
    const leaseTtlMs = this.resolveLeaseTtlMs(request.ttlMs);
    return this.refreshLease(lease, leaseTtlMs);
  }

  releaseLease(request: ReleaseLeaseRequest): { released: boolean } {
    const leaseId = this.normalizeRequiredLeaseId(request.leaseId);
    this.cleanupExpiredLeases();
    const lease = this.leases.get(leaseId);
    if (!lease) {
      return { released: false };
    }
    this.assertRequiredScopeForDeviceAwareLease(lease, request);
    this.assertOptionalScopeMatch(lease, request);
    this.leases.delete(leaseId);
    this.unbindLease(lease);
    return { released: true };
  }

  assertLeaseAdmission(request: AdmissionRequest): void {
    const backend = normalizeLeaseBackend(request.leaseBackend);
    const tenantId = normalizeTenantId(request.tenantId);
    if (!tenantId) {
      throw new AppError('INVALID_ARGS', 'tenant isolation requires tenant id.');
    }
    const runId = normalizeRunId(request.runId);
    if (!runId) {
      throw new AppError('INVALID_ARGS', 'tenant isolation requires run id.');
    }
    const leaseId = normalizeLeaseId(request.leaseId);
    if (!leaseId) {
      throw new AppError('INVALID_ARGS', 'tenant isolation requires lease id.');
    }
    this.cleanupExpiredLeases();
    const lease = this.getActiveLease(leaseId);
    this.assertOptionalScopeMatch(lease, {
      tenantId,
      runId,
      leaseBackend: backend,
      leaseProvider: request.leaseProvider,
      deviceKey: request.deviceKey,
      clientId: request.clientId,
    });
  }

  listActiveLeases(): DeviceLease[] {
    this.cleanupExpiredLeases();
    return Array.from(this.leases.values()).map((entry) => ({ ...entry }));
  }

  consumeExpiredLeases(): DeviceLease[] {
    const now = this.now();
    const expired: DeviceLease[] = [];
    for (const lease of this.leases.values()) {
      if (lease.expiresAt > now) continue;
      this.leases.delete(lease.leaseId);
      this.unbindLease(lease);
      expired.push({ ...lease });
    }
    return expired;
  }

  consumeExpiredLease(leaseId: string): DeviceLease | undefined {
    const normalizedLeaseId = normalizeLeaseId(leaseId);
    if (!normalizedLeaseId) return undefined;
    const lease = this.leases.get(normalizedLeaseId);
    if (!lease || lease.expiresAt > this.now()) return undefined;
    this.leases.delete(lease.leaseId);
    this.unbindLease(lease);
    return { ...lease };
  }

  private cleanupExpiredLeases(): void {
    this.consumeExpiredLeases();
  }

  private enforceCapacity(backend: LeaseBackend): void {
    if (backend !== 'ios-simulator') return;
    if (this.maxActiveSimulatorLeases <= 0) return;
    const activeSimulatorLeases = Array.from(this.leases.values()).filter(
      (lease) => lease.backend === 'ios-simulator',
    ).length;
    if (activeSimulatorLeases < this.maxActiveSimulatorLeases) return;
    throw new AppError('COMMAND_FAILED', 'No simulator lease capacity available', {
      reason: 'LEASE_CAPACITY_EXCEEDED',
      activeLeases: activeSimulatorLeases,
      maxActiveLeases: this.maxActiveSimulatorLeases,
      backend,
      hint: 'Retry after releasing another simulator lease.',
    });
  }

  private resolveLeaseTtlMs(raw: number | undefined): number {
    if (!Number.isInteger(raw)) return this.defaultLeaseTtlMs;
    const value = Number(raw);
    if (value < this.minLeaseTtlMs || value > this.maxLeaseTtlMs) {
      throw new AppError(
        'INVALID_ARGS',
        `Lease ttlMs must be between ${this.minLeaseTtlMs} and ${this.maxLeaseTtlMs}.`,
      );
    }
    return value;
  }

  private normalizeRequiredLeaseId(raw: string | undefined): string {
    const leaseId = normalizeLeaseId(raw);
    if (!leaseId) {
      throw new AppError('INVALID_ARGS', 'Invalid lease id.');
    }
    return leaseId;
  }

  private getActiveLease(leaseId: string): DeviceLease {
    const lease = this.leases.get(leaseId);
    if (lease) return lease;
    throw new AppError('UNAUTHORIZED', 'Lease is not active', {
      reason: 'LEASE_NOT_FOUND',
    });
  }

  private refreshLease(lease: DeviceLease, ttlMs: number): DeviceLease {
    const now = this.now();
    const updated: DeviceLease = {
      ...lease,
      heartbeatAt: now,
      expiresAt: now + ttlMs,
    };
    this.leases.set(updated.leaseId, updated);
    this.bindLease(updated);
    return { ...updated };
  }

  private bindLease(lease: DeviceLease): void {
    this.runBindings.set(
      this.bindingKey({
        tenantId: lease.tenantId,
        runId: lease.runId,
        backend: lease.backend,
        leaseProvider: lease.leaseProvider,
        deviceKey: lease.deviceKey,
      }),
      lease.leaseId,
    );
    const deviceBindingKey = this.deviceBindingKey(lease);
    if (deviceBindingKey) {
      this.deviceBindings.set(deviceBindingKey, lease.leaseId);
    }
  }

  private unbindLease(lease: DeviceLease): void {
    this.runBindings.delete(
      this.bindingKey({
        tenantId: lease.tenantId,
        runId: lease.runId,
        backend: lease.backend,
        leaseProvider: lease.leaseProvider,
        deviceKey: lease.deviceKey,
      }),
    );
    const deviceBindingKey = this.deviceBindingKey(lease);
    if (deviceBindingKey) {
      this.deviceBindings.delete(deviceBindingKey);
    }
  }

  private bindingKey(params: {
    tenantId: string;
    runId: string;
    backend: LeaseBackend;
    leaseProvider?: string;
    deviceKey?: string;
  }): string {
    return JSON.stringify([
      params.tenantId,
      params.runId,
      params.backend,
      params.leaseProvider ?? DEFAULT_LEASE_PROVIDER,
      params.deviceKey ?? '*',
    ]);
  }

  private deviceBindingKey(
    lease: Pick<DeviceLease, 'backend' | 'leaseProvider' | 'deviceKey'>,
  ): string | undefined {
    if (!lease.deviceKey) return undefined;
    return JSON.stringify([
      lease.backend,
      lease.leaseProvider ?? DEFAULT_LEASE_PROVIDER,
      lease.deviceKey,
    ]);
  }

  private assertDeviceAvailable(params: {
    backend: LeaseBackend;
    leaseProvider?: string;
    deviceKey?: string;
  }): void {
    const deviceBindingKey = this.deviceBindingKey({
      backend: params.backend,
      leaseProvider: params.leaseProvider,
      deviceKey: params.deviceKey,
    });
    if (!deviceBindingKey) return;
    const activeLeaseId = this.deviceBindings.get(deviceBindingKey);
    if (!activeLeaseId) return;
    const activeLease = this.leases.get(activeLeaseId);
    if (!activeLease) {
      this.deviceBindings.delete(deviceBindingKey);
      return;
    }
    this.throwDeviceBusy(activeLease);
  }

  private canReuseRunBinding(
    lease: DeviceLease,
    request: {
      clientId?: string;
    },
  ): boolean {
    return lease.clientId === request.clientId;
  }

  private throwDeviceBusy(activeLease: DeviceLease): never {
    throw new AppError('COMMAND_FAILED', 'Device is already leased', {
      reason: 'DEVICE_LEASE_BUSY',
      deviceKey: activeLease.deviceKey,
      backend: activeLease.backend,
      leaseProvider: activeLease.leaseProvider,
      expiresAt: activeLease.expiresAt,
      hint: 'Retry after the lease expires or close the owning session.',
    });
  }

  private assertRequiredScopeForDeviceAwareLease(
    lease: DeviceLease,
    request: LeaseScopeMatchRequest,
  ): void {
    if (!leaseRequiresOwnerScope(lease)) return;
    if (!hasRequiredOwnerScope(lease, request)) {
      this.throwScopeRequired();
    }
  }

  private assertOptionalScopeMatch(lease: DeviceLease, request: LeaseScopeMatchRequest): void {
    const normalized = this.normalizeOptionalScopeMatchRequest(request);
    if (
      (normalized.tenantId && lease.tenantId !== normalized.tenantId) ||
      (normalized.runId && lease.runId !== normalized.runId) ||
      (normalized.leaseBackend && lease.backend !== normalized.leaseBackend)
    ) {
      this.throwScopeMismatch();
    }
    this.assertOptionalLeaseIdentityMatch(lease, normalized);
  }

  private normalizeOptionalScopeMatchRequest(
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

  private assertOptionalLeaseIdentityMatch(
    lease: DeviceLease,
    request: {
      leaseProvider?: string;
      deviceKey?: string;
      clientId?: string;
    },
  ): void {
    if (request.leaseProvider && lease.leaseProvider !== request.leaseProvider) {
      this.throwScopeMismatch();
    }
    if (request.deviceKey && lease.deviceKey !== request.deviceKey) {
      this.throwScopeMismatch();
    }
    if (request.clientId && lease.clientId !== request.clientId) {
      this.throwScopeMismatch();
    }
  }

  private throwScopeMismatch(): never {
    throw new AppError('UNAUTHORIZED', 'Lease does not match tenant/run scope', {
      reason: 'LEASE_SCOPE_MISMATCH',
    });
  }

  private throwScopeRequired(): never {
    throw new AppError('UNAUTHORIZED', 'Lease owner scope is required', {
      reason: 'LEASE_SCOPE_REQUIRED',
    });
  }
}
