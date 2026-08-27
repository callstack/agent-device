import { AppError } from '@agent-device/kernel/errors';
import { deviceIdentityAliases } from '../core/lease-scope.ts';
import type { HumanControlHold, HumanControlHoldInput } from './human-control-contract.ts';
import {
  normalizeHumanControlHoldId,
  normalizeHumanControlHoldScope,
  normalizeHumanControlReason,
  normalizeHumanControlTtlMs,
} from './human-control-contract.ts';
import { cloneHumanControlHold, HumanControlStore } from './human-control-store.ts';

export const HUMAN_CONTROL_HTTP_PREFIX = '/admin/human-control/holds';

export class HumanControlRegistry {
  private readonly holds = new Map<string, HumanControlHold>();
  private readonly activeMutations = new Map<string, number>();
  private readonly idleWaiters = new Map<string, Set<() => void>>();
  private readonly store: HumanControlStore;
  private readonly now: () => number;

  constructor(options: { statePath?: string; now?: () => number } = {}) {
    this.store = new HumanControlStore(options.statePath);
    this.now = options.now ?? (() => Date.now());
    for (const hold of this.store.load()) this.holds.set(hold.id, hold);
    this.cleanupExpired();
  }

  list(): HumanControlHold[] {
    this.cleanupExpired();
    return Array.from(this.holds.values(), (hold) => cloneHumanControlHold(hold)).sort(
      (left, right) => left.id.localeCompare(right.id),
    );
  }

  async upsert(id: string, input: HumanControlHoldInput): Promise<HumanControlHold> {
    const normalizedId = normalizeHumanControlHoldId(id);
    const scope = normalizeHumanControlHoldScope(input.scope);
    const reason = normalizeHumanControlReason(input.reason);
    const ttlMs = normalizeHumanControlTtlMs(input.ttlMs);
    const now = this.now();
    const existing = this.holds.get(normalizedId);
    const pendingHold: HumanControlHold = {
      id: normalizedId,
      scope,
      ...(reason ? { reason } : {}),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.holds.set(normalizedId, pendingHold);
    this.persist();
    await this.waitForDeviceIdle([scope.deviceKey]);
    if (this.holds.get(normalizedId) !== pendingHold) {
      throw new AppError(
        'COMMAND_FAILED',
        'Human-control hold changed before activation completed.',
        { holdId: normalizedId },
      );
    }
    const activatedAt = this.now();
    const activeHold: HumanControlHold = {
      ...pendingHold,
      updatedAt: activatedAt,
      ...(ttlMs === undefined ? {} : { expiresAt: activatedAt + ttlMs }),
    };
    this.holds.set(normalizedId, activeHold);
    this.persist();
    return cloneHumanControlHold(activeHold);
  }

  remove(id: string): HumanControlHold | undefined {
    const normalizedId = normalizeHumanControlHoldId(id);
    const hold = this.holds.get(normalizedId);
    if (!hold) return undefined;
    this.holds.delete(normalizedId);
    this.persist();
    return cloneHumanControlHold(hold);
  }

  isDeviceControlled(deviceKey: string | undefined): boolean {
    if (!deviceKey) return false;
    return this.findMatchingHold([deviceKey]) !== undefined;
  }

  findMatchingHold(deviceKeys: readonly string[]): HumanControlHold | undefined {
    this.cleanupExpired();
    const keys = normalizeDeviceAliases(deviceKeys);
    if (keys.length === 0) return undefined;
    for (const hold of this.holds.values()) {
      const holdKeys = normalizeDeviceAliases([hold.scope.deviceKey]);
      if (holdKeys.some((key) => keys.includes(key))) return cloneHumanControlHold(hold);
    }
    return undefined;
  }

  async runDeviceMutation<T>(deviceKeys: readonly string[], task: () => Promise<T>): Promise<T> {
    const keys = normalizeDeviceAliases(deviceKeys);
    const hold = this.findMatchingHold(keys);
    if (hold) throw humanControlActiveError(hold);
    if (keys.length === 0) return await task();

    for (const key of keys) {
      this.activeMutations.set(key, (this.activeMutations.get(key) ?? 0) + 1);
    }
    try {
      return await task();
    } finally {
      for (const key of keys) this.finishMutation(key);
    }
  }

  private async waitForDeviceIdle(deviceKeys: readonly string[]): Promise<void> {
    await Promise.all(
      normalizeDeviceAliases(deviceKeys).map(async (key) => this.waitForKeyIdle(key)),
    );
  }

  private async waitForKeyIdle(key: string): Promise<void> {
    if ((this.activeMutations.get(key) ?? 0) === 0) return;
    await new Promise<void>((resolve) => {
      const waiters = this.idleWaiters.get(key) ?? new Set<() => void>();
      waiters.add(resolve);
      this.idleWaiters.set(key, waiters);
    });
  }

  private finishMutation(key: string): void {
    const remaining = (this.activeMutations.get(key) ?? 1) - 1;
    if (remaining > 0) {
      this.activeMutations.set(key, remaining);
      return;
    }
    this.activeMutations.delete(key);
    const waiters = this.idleWaiters.get(key);
    if (!waiters) return;
    this.idleWaiters.delete(key);
    for (const resolve of waiters) resolve();
  }

  private cleanupExpired(): void {
    const now = this.now();
    let changed = false;
    for (const [id, hold] of this.holds) {
      if (hold.expiresAt === undefined || hold.expiresAt > now) continue;
      this.holds.delete(id);
      changed = true;
    }
    if (changed) this.persist();
  }

  private persist(): void {
    this.store.persist(this.holds.values());
  }
}

function humanControlActiveError(hold: HumanControlHold): AppError {
  return new AppError(
    'DEVICE_IN_USE',
    'A human is interacting with this simulator or device; agent interactions are temporarily disabled.',
    {
      reason: 'human_control_active',
      blockedBy: 'human_control',
      holdId: hold.id,
      deviceKey: hold.scope.deviceKey,
      pausedAt: new Date(hold.createdAt).toISOString(),
      ...(hold.expiresAt === undefined
        ? {}
        : { expiresAt: new Date(hold.expiresAt).toISOString() }),
      ...(hold.reason ? { humanReason: hold.reason } : {}),
      hint: 'Wait until the human-control hold is released before retrying.',
    },
  );
}

export function releaseHumanControlHold(
  registry: HumanControlRegistry,
  holdId: string,
): HumanControlHold | undefined {
  return registry.remove(holdId);
}

function normalizeDeviceAliases(deviceKeys: readonly string[]): string[] {
  return Array.from(
    new Set(
      deviceIdentityAliases(deviceKeys)
        .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
        .map((value) => normalizeDeviceAlias(value)),
    ),
  );
}

function normalizeDeviceAlias(value: string): string {
  return value.trim().toLocaleLowerCase('en-US');
}
