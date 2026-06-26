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
  provider?: string;
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
  backend?: LeaseBackend;
  provider?: string;
  leaseProvider?: string;
  deviceKey?: string;
  clientId?: string;
  ttlMs?: number;
};

export type HeartbeatLeaseRequest = {
  leaseId: string;
  tenantId?: string;
  runId?: string;
  backend?: LeaseBackend;
  provider?: string;
  leaseProvider?: string;
  deviceKey?: string;
  clientId?: string;
  ttlMs?: number;
};

export type ReleaseLeaseRequest = {
  leaseId: string;
  tenantId?: string;
  runId?: string;
  backend?: LeaseBackend;
  provider?: string;
  leaseProvider?: string;
  deviceKey?: string;
  clientId?: string;
};

export type AdmissionRequest = {
  tenantId: string | undefined;
  runId: string | undefined;
  leaseId: string | undefined;
  backend?: LeaseBackend;
  provider?: string;
  leaseProvider?: string;
  deviceKey?: string;
  clientId?: string;
};

type LeaseScopeMatchRequest = {
  tenantId?: string;
  runId?: string;
  backend?: LeaseBackend;
  provider?: string;
  leaseProvider?: string;
  deviceKey?: string;
  clientId?: string;
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

function normalizeLeaseProviderFields(request: {
  provider?: string;
  leaseProvider?: string;
}): string | undefined {
  const provider = normalizeAgentIdentifier(request.provider, 'lease provider', 64);
  const leaseProvider = normalizeAgentIdentifier(request.leaseProvider, 'lease provider', 64);
  if (provider && leaseProvider && provider !== leaseProvider) {
    throw new AppError('INVALID_ARGS', 'Conflicting lease provider values.');
  }
  return leaseProvider ?? provider;
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
    const backend = normalizeLeaseBackend(request.backend);
    const provider = normalizeLeaseProviderFields(request);
    const deviceKey = normalizeDeviceKey(request.deviceKey);
    const clientId = normalizeClientId(request.clientId);
    const tenantId = normalizeTenantId(request.tenantId);
    if (!tenantId) {
      throw new AppError(
        'INVALID_ARGS',
        'Invalid tenant id. Use 1-128 chars: letters, numbers, dot, underscore, hyphen.',
      );
    }
    const runId = normalizeRunId(request.runId);
    if (!runId) {
      throw new AppError(
        'INVALID_ARGS',
        'Invalid run id. Use 1-128 chars: letters, numbers, dot, underscore, hyphen.',
      );
    }
    this.cleanupExpiredLeases();
    const leaseTtlMs = this.resolveLeaseTtlMs(request.ttlMs);
    const bindingKey = this.bindingKey({ tenantId, runId, backend, provider, deviceKey });
    const existingId = this.runBindings.get(bindingKey);
    if (existingId) {
      const existingLease = this.leases.get(existingId);
      if (existingLease) {
        this.assertOptionalLeaseIdentityMatch(existingLease, { clientId });
        return this.refreshLease(existingLease, leaseTtlMs);
      }
      this.runBindings.delete(bindingKey);
    }
    this.assertDeviceAvailable({ backend, provider, deviceKey });
    this.enforceCapacity(backend);
    const now = this.now();
    const lease: DeviceLease = {
      leaseId: crypto.randomBytes(16).toString('hex'),
      tenantId,
      runId,
      backend,
      ...(provider ? { leaseProvider: provider, provider } : {}),
      ...(deviceKey ? { deviceKey } : {}),
      ...(clientId ? { clientId } : {}),
      createdAt: now,
      heartbeatAt: now,
      expiresAt: now + leaseTtlMs,
    };
    this.leases.set(lease.leaseId, lease);
    this.bindLease(lease);
    return { ...lease };
  }

  heartbeatLease(request: HeartbeatLeaseRequest): DeviceLease {
    const leaseId = this.normalizeRequiredLeaseId(request.leaseId);
    this.cleanupExpiredLeases();
    const lease = this.getActiveLease(leaseId);
    this.assertOptionalScopeMatch(lease, this.scopeMatchRequest(request));
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
    this.assertOptionalScopeMatch(lease, this.scopeMatchRequest(request));
    this.leases.delete(leaseId);
    this.unbindLease(lease);
    return { released: true };
  }

  assertLeaseAdmission(request: AdmissionRequest): void {
    const backend = normalizeLeaseBackend(request.backend);
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
      backend,
      provider: request.provider,
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

  private scopeMatchRequest(request: LeaseScopeMatchRequest): LeaseScopeMatchRequest {
    return {
      tenantId: request.tenantId,
      runId: request.runId,
      backend: request.backend,
      provider: request.provider,
      leaseProvider: request.leaseProvider,
      deviceKey: request.deviceKey,
      clientId: request.clientId,
    };
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
        provider: lease.leaseProvider,
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
        provider: lease.leaseProvider,
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
    provider?: string;
    deviceKey?: string;
  }): string {
    return JSON.stringify([
      params.tenantId,
      params.runId,
      params.backend,
      params.provider ?? DEFAULT_LEASE_PROVIDER,
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
    provider?: string;
    deviceKey?: string;
  }): void {
    const deviceBindingKey = this.deviceBindingKey({
      backend: params.backend,
      leaseProvider: params.provider,
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
    throw new AppError('COMMAND_FAILED', 'Device is already leased', {
      reason: 'DEVICE_LEASE_BUSY',
      deviceKey: activeLease.deviceKey,
      backend: activeLease.backend,
      leaseProvider: activeLease.leaseProvider,
      leaseId: activeLease.leaseId,
      tenantId: activeLease.tenantId,
      runId: activeLease.runId,
      expiresAt: activeLease.expiresAt,
      hint: 'Retry after the lease expires or close the owning session.',
    });
  }

  // fallow-ignore-next-line complexity
  private assertOptionalScopeMatch(
    lease: DeviceLease,
    request: {
      tenantId?: string;
      runId?: string;
      backend?: LeaseBackend;
      provider?: string;
      leaseProvider?: string;
      deviceKey?: string;
      clientId?: string;
    },
  ): void {
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
    const backend = request.backend ? normalizeLeaseBackend(request.backend) : undefined;
    const provider = normalizeLeaseProviderFields(request);
    const deviceKey = normalizeDeviceKey(request.deviceKey);
    const clientId = normalizeClientId(request.clientId);
    if (
      (tenantId && lease.tenantId !== tenantId) ||
      (runId && lease.runId !== runId) ||
      (backend && lease.backend !== backend)
    ) {
      this.throwScopeMismatch();
    }
    this.assertOptionalLeaseIdentityMatch(lease, { provider, deviceKey, clientId });
  }

  private assertOptionalLeaseIdentityMatch(
    lease: DeviceLease,
    request: {
      provider?: string;
      deviceKey?: string;
      clientId?: string;
    },
  ): void {
    if (request.provider && lease.leaseProvider !== request.provider) {
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
}
