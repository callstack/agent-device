import fs from 'node:fs';
import path from 'node:path';
import { AppError } from '@agent-device/kernel/errors';
import { deviceIdentityAliases } from '../core/lease-scope.ts';
import type {
  HumanControlHold,
  HumanControlHoldInput,
  HumanControlHoldScope,
} from './human-control-contract.ts';

export const HUMAN_CONTROL_HTTP_PREFIX = '/admin/human-control/holds';

const MIN_HOLD_TTL_MS = 1_000;
const MAX_HOLD_TTL_MS = 24 * 60 * 60_000;

export class HumanControlRegistry {
  private readonly holds = new Map<string, HumanControlHold>();
  private readonly activeMutations = new Map<string, number>();
  private readonly idleWaiters = new Map<string, Set<() => void>>();
  private readonly statePath: string | undefined;
  private readonly now: () => number;

  constructor(options: { statePath?: string; now?: () => number } = {}) {
    this.statePath = options.statePath;
    this.now = options.now ?? (() => Date.now());
    this.load();
  }

  list(): HumanControlHold[] {
    this.cleanupExpired();
    return Array.from(this.holds.values(), (hold) => cloneHold(hold)).sort((left, right) =>
      left.id.localeCompare(right.id),
    );
  }

  async upsert(id: string, input: HumanControlHoldInput): Promise<HumanControlHold> {
    const normalizedId = normalizeHoldId(id);
    const scope = normalizeScope(input.scope);
    const reason = normalizeReason(input.reason);
    const ttlMs = normalizeTtlMs(input.ttlMs);
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
    return cloneHold(activeHold);
  }

  remove(id: string): HumanControlHold | undefined {
    const normalizedId = normalizeHoldId(id);
    const hold = this.holds.get(normalizedId);
    if (!hold) return undefined;
    this.holds.delete(normalizedId);
    this.persist();
    return cloneHold(hold);
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
      if (holdKeys.some((key) => keys.includes(key))) return cloneHold(hold);
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

  private load(): void {
    if (!this.statePath || !fs.existsSync(this.statePath)) return;
    let parsed: { version: 1; holds: HumanControlHold[] };
    try {
      parsed = JSON.parse(fs.readFileSync(this.statePath, 'utf8')) as typeof parsed;
    } catch (error) {
      throw new AppError(
        'COMMAND_FAILED',
        'Failed to read persisted human-control state.',
        { path: this.statePath },
        error,
      );
    }
    if (parsed.version !== 1 || !Array.isArray(parsed.holds)) {
      throw new AppError('COMMAND_FAILED', 'Persisted human-control state is invalid.', {
        path: this.statePath,
      });
    }
    for (const rawHold of parsed.holds) {
      const hold = normalizeStoredHold(rawHold);
      this.holds.set(hold.id, hold);
    }
    this.cleanupExpired();
  }

  private persist(): void {
    if (!this.statePath) return;
    fs.mkdirSync(path.dirname(this.statePath), { recursive: true });
    const temporaryPath = `${this.statePath}.${String(process.pid)}.tmp`;
    const state = {
      version: 1,
      holds: Array.from(this.holds.values(), (hold) => cloneHold(hold)),
    };
    fs.writeFileSync(temporaryPath, JSON.stringify(state, null, 2), { mode: 0o600 });
    fs.renameSync(temporaryPath, this.statePath);
    fs.chmodSync(this.statePath, 0o600);
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

function normalizeStoredHold(raw: HumanControlHold): HumanControlHold {
  if (!raw || typeof raw !== 'object') {
    throw new AppError('COMMAND_FAILED', 'Persisted human-control hold is invalid.');
  }
  const createdAt = normalizeTimestamp(raw.createdAt, 'createdAt');
  const updatedAt = normalizeTimestamp(raw.updatedAt, 'updatedAt');
  const expiresAt =
    raw.expiresAt === undefined ? undefined : normalizeTimestamp(raw.expiresAt, 'expiresAt');
  const reason = normalizeReason(raw.reason);
  return {
    id: normalizeHoldId(raw.id),
    scope: normalizeScope(raw.scope),
    ...(reason ? { reason } : {}),
    createdAt,
    updatedAt,
    ...(expiresAt === undefined ? {} : { expiresAt }),
  };
}

function normalizeScope(scope: HumanControlHoldScope): HumanControlHoldScope {
  if (!scope || typeof scope !== 'object') {
    throw new AppError('INVALID_ARGS', 'Human-control hold requires a device scope.');
  }
  const deviceName = normalizeOptionalLabel(scope.deviceName, 'device name');
  const platform = normalizeOptionalLabel(scope.platform, 'platform');
  const kind = normalizeOptionalLabel(scope.kind, 'device kind');
  return {
    deviceKey: normalizeDeviceKey(scope.deviceKey),
    ...(deviceName ? { deviceName } : {}),
    ...(platform ? { platform } : {}),
    ...(kind ? { kind } : {}),
  };
}

function normalizeHoldId(id: string): string {
  const value = typeof id === 'string' ? id.trim() : '';
  if (!/^[a-zA-Z0-9._-]{1,128}$/.test(value)) {
    throw new AppError(
      'INVALID_ARGS',
      'Invalid human-control hold id. Use 1-128 chars: letters, numbers, dot, underscore, hyphen.',
    );
  }
  return value;
}

function normalizeDeviceKey(deviceKey: string): string {
  const value = typeof deviceKey === 'string' ? deviceKey.trim() : '';
  if (!value || value.length > 256 || !/^[\x20-\x7E]+$/.test(value)) {
    throw new AppError('INVALID_ARGS', 'Invalid device key. Use 1-256 printable characters.');
  }
  return value;
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

function normalizeOptionalLabel(value: string | undefined, label: string): string | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim();
  if (!normalized || normalized.length > 256) {
    throw new AppError('INVALID_ARGS', `Invalid ${label}. Use 1-256 characters.`);
  }
  return normalized;
}

function normalizeReason(reason: string | undefined): string | undefined {
  if (reason === undefined) return undefined;
  const value = reason.trim();
  if (!value) return undefined;
  if (value.length > 512) {
    throw new AppError('INVALID_ARGS', 'Human-control reason must be at most 512 characters.');
  }
  return value;
}

function normalizeTtlMs(ttlMs: number | undefined): number | undefined {
  if (ttlMs === undefined) return undefined;
  if (!Number.isInteger(ttlMs) || ttlMs < MIN_HOLD_TTL_MS || ttlMs > MAX_HOLD_TTL_MS) {
    throw new AppError(
      'INVALID_ARGS',
      `Human-control ttlMs must be between ${String(MIN_HOLD_TTL_MS)} and ${String(MAX_HOLD_TTL_MS)}.`,
    );
  }
  return ttlMs;
}

function normalizeTimestamp(value: number, field: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new AppError('COMMAND_FAILED', `Persisted human-control ${field} is invalid.`);
  }
  return value;
}

function cloneHold(hold: HumanControlHold): HumanControlHold {
  return { ...hold, scope: { ...hold.scope } };
}
