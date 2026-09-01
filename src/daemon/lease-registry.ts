import type { DeviceLease } from '@agent-device/contracts/device';
import type { HumanControlHold, HumanControlHoldScope } from '@agent-device/contracts/client';
import type { LeaseBackend } from '@agent-device/kernel/contracts';
import { AppError } from '@agent-device/kernel/errors';
import {
  ProviderSessionOwnershipRegistry,
  type ProviderSessionOwnership,
} from './provider-session-ownership.ts';
import {
  type AdmissionRequest,
  type AllocateLeaseRequest,
  type HeartbeatLeaseRequest,
  type ReleaseLeaseRequest,
  type LeaseRegistryOptions,
  type NormalizedAllocateLeaseRequest,
  createLeaseTtlResolver,
  normalizeAllocateLeaseRequest,
  createDeviceLease,
  deviceLeaseBusyError,
  normalizeLeaseId,
  normalizeRequiredLeaseId,
  normalizeLeaseAdmissionRequest,
  assertLeaseOwnerScope,
  assertLeaseScopeMatch,
  leaseDeviceBindingKey,
  leaseRunBindingKey,
} from './lease-registry-scope.ts';
import { DeviceMutationDrain } from './device-mutation-drain.ts';
import {
  type HumanControlAuthority,
  type HumanControlHoldInput,
  normalizeHumanControlHoldId,
  parseHumanControlHoldInput,
  cloneHumanControlHold,
  humanControlActiveError,
} from './human-control-contract.ts';

export type SimulatorLease = DeviceLease;

type OwnedHumanControlHold = { hold: HumanControlHold; ownerLeaseId?: string };

export class LeaseRegistry {
  private readonly holdsByDevice = new Map<string, Map<string, OwnedHumanControlHold>>();
  private readonly mutations = new DeviceMutationDrain();
  private readonly leases = new Map<string, DeviceLease>();
  private readonly runBindings = new Map<string, string>();
  private readonly deviceBindings = new Map<string, string>();
  private readonly maxActiveSimulatorLeases: number;
  private readonly resolveLeaseTtlMs: ReturnType<typeof createLeaseTtlResolver>;
  private readonly now: () => number;
  private readonly onLeaseExpired?: (lease: DeviceLease) => void;
  private readonly providerSessionOwnership: ProviderSessionOwnershipRegistry;

  constructor(options: LeaseRegistryOptions = {}) {
    this.maxActiveSimulatorLeases = Number.isInteger(options.maxActiveSimulatorLeases)
      ? Math.max(0, Number(options.maxActiveSimulatorLeases))
      : 0;
    this.resolveLeaseTtlMs = createLeaseTtlResolver(options);
    this.now = options.now ?? (() => Date.now());
    this.onLeaseExpired = options.onLeaseExpired;
    this.providerSessionOwnership = new ProviderSessionOwnershipRegistry({
      now: this.now,
      retentionMs: options.providerSessionRetentionMs,
    });
  }

  allocateLease(request: AllocateLeaseRequest): DeviceLease {
    const normalized = normalizeAllocateLeaseRequest(request);
    this.cleanupExpiredLeases();
    const leaseTtlMs = this.resolveLeaseTtlMs(normalized.ttlMs);
    this.assertHumanControlAdmission(normalized);
    const existingLease = this.refreshExistingRunBinding(normalized, leaseTtlMs);
    if (existingLease) return existingLease;
    this.assertDeviceAvailable(normalized);
    this.enforceCapacity(normalized.backend);
    const lease = createDeviceLease(normalized, leaseTtlMs, this.now());
    this.leases.set(lease.leaseId, lease);
    this.bindLease(lease);
    return { ...lease };
  }

  private refreshExistingRunBinding(
    request: NormalizedAllocateLeaseRequest,
    leaseTtlMs: number,
  ): DeviceLease | undefined {
    const bindingKey = leaseRunBindingKey(request);
    const existingId = this.runBindings.get(bindingKey);
    if (!existingId) return undefined;
    const existingLease = this.leases.get(existingId);
    if (!existingLease) {
      this.runBindings.delete(bindingKey);
      return undefined;
    }
    if (existingLease.clientId === request.clientId) {
      return this.refreshLease(existingLease, leaseTtlMs);
    }
    if (existingLease.deviceKey) {
      throw deviceLeaseBusyError(existingLease);
    }
    assertLeaseScopeMatch(existingLease, request);
    return this.refreshLease(existingLease, leaseTtlMs);
  }

  heartbeatLease(request: HeartbeatLeaseRequest): DeviceLease {
    const leaseId = normalizeRequiredLeaseId(request.leaseId);
    this.cleanupExpiredLeases();
    const lease = this.getActiveLease(leaseId);
    assertLeaseOwnerScope(lease, request);
    assertLeaseScopeMatch(lease, request);
    const leaseTtlMs = this.resolveLeaseTtlMs(request.ttlMs);
    return this.refreshLease(lease, leaseTtlMs);
  }

  releaseLease(request: ReleaseLeaseRequest): { released: boolean; lease?: DeviceLease } {
    const lease = this.getLease(request);
    if (!lease) {
      return { released: false };
    }
    this.leases.delete(lease.leaseId);
    this.unbindLease(lease);
    return { released: true, lease };
  }

  /**
   * Reads a releasable lease without committing its removal. Callers with an
   * external provider use this to release the remote resource first, so a
   * transient provider failure leaves the local lease available for retry.
   */
  getLease(request: ReleaseLeaseRequest): DeviceLease | undefined {
    const leaseId = normalizeRequiredLeaseId(request.leaseId);
    this.cleanupExpiredLeases();
    const lease = this.leases.get(leaseId);
    if (!lease) return undefined;
    assertLeaseOwnerScope(lease, request);
    assertLeaseScopeMatch(lease, request);
    return { ...lease };
  }

  assertLeaseAdmission(request: AdmissionRequest): void {
    const scope = normalizeLeaseAdmissionRequest(request);
    this.cleanupExpiredLeases();
    assertLeaseScopeMatch(this.getActiveLease(scope.leaseId), scope);
  }

  listActiveLeases(): DeviceLease[] {
    this.cleanupExpiredLeases();
    return Array.from(this.leases.values()).map((entry) => ({ ...entry }));
  }

  recordProviderSession(
    lease: Pick<DeviceLease, 'leaseId' | 'tenantId' | 'leaseProvider' | 'expiresAt'>,
    providerSessionId: string,
  ): void {
    this.cleanupExpiredLeases();
    const releasedAt = lease.expiresAt <= this.now() ? lease.expiresAt : undefined;
    this.providerSessionOwnership.record(lease, providerSessionId);
    if (!this.leases.has(lease.leaseId)) {
      this.providerSessionOwnership.markLeaseReleased(lease, releasedAt);
    }
  }

  resolveProviderSession(params: {
    provider?: string;
    providerSessionId?: string;
    tenantId?: string;
  }): ProviderSessionOwnership | undefined {
    this.cleanupExpiredLeases();
    return this.providerSessionOwnership.resolve(params);
  }

  listHumanControlHolds(authority: HumanControlAuthority): HumanControlHold[] {
    this.cleanupExpiredLeases();
    const key =
      authority.kind === 'lease'
        ? leaseDeviceBindingKey(this.requireHumanControlLease(authority.leaseId))
        : undefined;
    const holds = [...this.holdsByDevice.entries()]
      .filter(([deviceKey]) => key === undefined || key === deviceKey)
      .flatMap(([, entries]) =>
        [...entries.values()].map(({ hold }) => cloneHumanControlHold(hold)),
      );
    return holds.sort((left, right) => left.id.localeCompare(right.id));
  }

  async putHumanControlHold(
    authority: HumanControlAuthority,
    rawId: string,
    rawInput: HumanControlHoldInput,
    signal?: AbortSignal,
  ): Promise<HumanControlHold> {
    signal?.throwIfAborted();
    const id = normalizeHumanControlHoldId(rawId);
    const input = parseHumanControlHoldInput(rawInput);
    this.cleanupExpiredLeases();
    const scope = this.resolveHumanControlScope(authority, input);
    const key = leaseDeviceBindingKey(scope)!;
    const existing = this.findHumanControlHold(id);
    if (existing) {
      this.assertHoldAuthority(authority, existing);
      if (leaseDeviceBindingKey(existing.hold.scope) !== key) {
        throw new AppError('INVALID_ARGS', 'Release a hold before changing its device scope.');
      }
    }
    const now = this.now();
    const pending: OwnedHumanControlHold = {
      ...(authority.kind === 'lease' ? { ownerLeaseId: authority.leaseId } : {}),
      hold: {
        id,
        scope,
        state: 'activating',
        ...(input.reason ? { reason: input.reason } : {}),
        createdAt: existing?.hold.createdAt ?? now,
        updatedAt: now,
      },
    };
    const holds = this.holdsByDevice.get(key) ?? new Map<string, OwnedHumanControlHold>();
    this.holdsByDevice.set(key, holds);
    holds.set(id, pending);
    return await this.activateHumanControlHold(key, pending, input.ttlMs, signal);
  }

  private async activateHumanControlHold(
    key: string,
    pending: OwnedHumanControlHold,
    ttlMs: number | undefined,
    signal?: AbortSignal,
  ): Promise<HumanControlHold> {
    const holds = this.holdsByDevice.get(key)!;
    const { id } = pending.hold;
    try {
      await this.mutations.wait(key, signal);
      signal?.throwIfAborted();
      if (holds.get(id) !== pending) {
        throw new AppError(
          'COMMAND_FAILED',
          'Human-control hold changed before activation completed.',
          { holdId: id },
        );
      }
      const activatedAt = this.now();
      pending.hold = {
        ...pending.hold,
        state: 'active',
        updatedAt: activatedAt,
        ...(ttlMs === undefined ? {} : { expiresAt: activatedAt + ttlMs }),
      };
      this.refreshHeldLease(key, activatedAt);
      return cloneHumanControlHold(pending.hold);
    } catch (error) {
      if (holds.get(id) === pending) this.deleteHumanControlHold(key, id);
      throw error;
    }
  }

  removeHumanControlHold(
    authority: HumanControlAuthority,
    rawId: string,
  ): HumanControlHold | undefined {
    const id = normalizeHumanControlHoldId(rawId);
    this.cleanupExpiredLeases();
    const existing = this.findHumanControlHold(id);
    if (!existing) return undefined;
    this.assertHoldAuthority(authority, existing);
    const key = leaseDeviceBindingKey(existing.hold.scope)!;
    this.deleteHumanControlHold(key, id);
    return cloneHumanControlHold(existing.hold);
  }

  private deleteHumanControlHold(key: string, id: string): void {
    const holds = this.holdsByDevice.get(key)!;
    holds.delete(id);
    if (holds.size === 0) {
      this.holdsByDevice.delete(key);
      this.refreshHeldLease(key, this.now());
    }
  }

  assertHumanControlAdmission(
    scope: Pick<DeviceLease, 'backend' | 'leaseProvider' | 'deviceKey'>,
  ): void {
    this.expireHumanControlHolds();
    const key = leaseDeviceBindingKey(scope);
    const entry =
      key === undefined ? undefined : this.holdsByDevice.get(key)?.values().next().value;
    if (entry) throw humanControlActiveError(entry.hold);
  }

  async runDeviceMutation<T>(lease: DeviceLease | undefined, task: () => Promise<T>): Promise<T> {
    if (!lease) return await task();
    this.cleanupExpiredLeases();
    const activeLease = this.getActiveLease(lease.leaseId);
    this.assertHumanControlAdmission(activeLease);
    const key = leaseDeviceBindingKey(activeLease);
    return key === undefined ? await task() : await this.mutations.run(key, task);
  }

  private requireHumanControlLease(leaseId: string): DeviceLease & { deviceKey: string } {
    const lease = this.getActiveLease(leaseId);
    if (!lease.deviceKey) {
      throw new AppError(
        'UNSUPPORTED_OPERATION',
        'Human control requires a device-scoped remote lease.',
      );
    }
    return { ...lease, deviceKey: lease.deviceKey };
  }

  private resolveHumanControlScope(
    authority: HumanControlAuthority,
    input: HumanControlHoldInput,
  ): HumanControlHoldScope {
    if (authority.kind === 'host') {
      if (!input.scope)
        throw new AppError('INVALID_ARGS', 'Host human control requires a lease device scope.');
      return input.scope;
    }
    if (input.scope) {
      throw new AppError(
        'INVALID_ARGS',
        'Lease-owner human control uses the admitted lease device; do not supply scope.',
      );
    }
    const lease = this.requireHumanControlLease(authority.leaseId);
    return {
      backend: lease.backend,
      leaseProvider: lease.leaseProvider,
      deviceKey: lease.deviceKey,
    };
  }

  private assertHoldAuthority(
    authority: HumanControlAuthority,
    entry: OwnedHumanControlHold,
  ): void {
    if (authority.kind === 'host') return;
    const lease = this.requireHumanControlLease(authority.leaseId);
    if (
      entry.ownerLeaseId !== lease.leaseId ||
      leaseDeviceBindingKey(lease) !== leaseDeviceBindingKey(entry.hold.scope)
    ) {
      throw new AppError(
        'UNAUTHORIZED',
        'Human-control hold does not belong to the admitted lease.',
        { reason: 'LEASE_SCOPE_MISMATCH' },
      );
    }
  }

  private findHumanControlHold(id: string): OwnedHumanControlHold | undefined {
    for (const holds of this.holdsByDevice.values()) {
      const entry = holds.get(id);
      if (entry) return entry;
    }
    return undefined;
  }

  private hasHumanControl(lease: DeviceLease): boolean {
    const key = leaseDeviceBindingKey(lease);
    return key !== undefined && this.holdsByDevice.has(key);
  }

  private expireHumanControlHolds(): void {
    const now = this.now();
    for (const [key, holds] of this.holdsByDevice) {
      let releasedAt = 0;
      for (const [id, { hold }] of holds) {
        if (hold.expiresAt === undefined || hold.expiresAt > now) continue;
        releasedAt = Math.max(releasedAt, hold.expiresAt);
        holds.delete(id);
      }
      if (holds.size === 0) {
        this.holdsByDevice.delete(key);
        this.refreshHeldLease(key, releasedAt);
      }
    }
  }

  private refreshHeldLease(key: string, at: number): void {
    const leaseId = this.deviceBindings.get(key);
    const lease = leaseId ? this.leases.get(leaseId) : undefined;
    if (lease) {
      this.refreshLease(
        lease,
        lease.expiresAt - lease.heartbeatAt,
        Math.max(at, lease.heartbeatAt),
      );
    }
  }

  consumeExpiredLeases(): DeviceLease[] {
    this.expireHumanControlHolds();
    const now = this.now();
    const expired: DeviceLease[] = [];
    for (const lease of this.leases.values()) {
      if (lease.expiresAt > now || this.hasHumanControl(lease)) continue;
      this.leases.delete(lease.leaseId);
      this.unbindLease(lease, lease.expiresAt);
      const expiredLease = { ...lease };
      expired.push(expiredLease);
      this.onLeaseExpired?.(expiredLease);
    }
    return expired;
  }

  consumeExpiredLease(leaseId: string): DeviceLease | undefined {
    this.expireHumanControlHolds();
    const normalizedLeaseId = normalizeLeaseId(leaseId);
    if (!normalizedLeaseId) return undefined;
    const lease = this.leases.get(normalizedLeaseId);
    if (!lease || lease.expiresAt > this.now() || this.hasHumanControl(lease)) {
      return undefined;
    }
    this.leases.delete(lease.leaseId);
    this.unbindLease(lease, lease.expiresAt);
    const expiredLease = { ...lease };
    this.onLeaseExpired?.(expiredLease);
    return expiredLease;
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
    throw new AppError('DEVICE_IN_USE', 'No simulator lease capacity available', {
      reason: 'LEASE_CAPACITY_EXCEEDED',
      activeLeases: activeSimulatorLeases,
      maxActiveLeases: this.maxActiveSimulatorLeases,
      backend,
      hint: 'Retry after releasing another simulator lease.',
    });
  }

  private getActiveLease(leaseId: string): DeviceLease {
    const lease = this.leases.get(leaseId);
    if (lease) return lease;
    throw new AppError('UNAUTHORIZED', 'Lease is not active', {
      reason: 'LEASE_NOT_FOUND',
    });
  }

  private refreshLease(lease: DeviceLease, ttlMs: number, now = this.now()): DeviceLease {
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
    this.runBindings.set(leaseRunBindingKey(lease), lease.leaseId);
    const deviceBindingKey = leaseDeviceBindingKey(lease);
    if (deviceBindingKey) {
      this.deviceBindings.set(deviceBindingKey, lease.leaseId);
    }
  }

  private unbindLease(lease: DeviceLease, releasedAt = this.now()): void {
    this.runBindings.delete(leaseRunBindingKey(lease));
    const deviceBindingKey = leaseDeviceBindingKey(lease);
    if (deviceBindingKey) {
      this.deviceBindings.delete(deviceBindingKey);
    }
    this.providerSessionOwnership.markLeaseReleased(lease, releasedAt);
  }

  private assertDeviceAvailable(params: {
    backend: LeaseBackend;
    leaseProvider?: string;
    deviceKey?: string;
  }): void {
    const deviceBindingKey = leaseDeviceBindingKey({
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
    throw deviceLeaseBusyError(activeLease);
  }
}
