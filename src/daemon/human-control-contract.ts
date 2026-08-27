import { AppError } from '@agent-device/kernel/errors';

const MIN_HOLD_TTL_MS = 1_000;
const MAX_HOLD_TTL_MS = 24 * 60 * 60_000;

export type HumanControlHoldScope = {
  deviceKey: string;
  deviceName?: string;
  platform?: string;
  kind?: string;
};

export type HumanControlHold = {
  id: string;
  scope: HumanControlHoldScope;
  reason?: string;
  createdAt: number;
  updatedAt: number;
  expiresAt?: number;
};

export type HumanControlHoldInput = {
  scope: HumanControlHoldScope;
  reason?: string;
  ttlMs?: number;
};

export function parseHumanControlHoldInput(value: unknown): HumanControlHoldInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AppError('INVALID_ARGS', 'Human-control request body must be an object.');
  }
  const record = value as Record<string, unknown>;
  const scope = record.scope;
  if (!scope || typeof scope !== 'object' || Array.isArray(scope)) {
    throw new AppError('INVALID_ARGS', 'Human-control request requires scope.deviceKey.');
  }
  const scopeRecord = scope as Record<string, unknown>;
  return {
    scope: {
      deviceKey: readRequiredString(scopeRecord.deviceKey, 'scope.deviceKey'),
      ...readOptionalStringField(scopeRecord, 'deviceName'),
      ...readOptionalStringField(scopeRecord, 'platform'),
      ...readOptionalStringField(scopeRecord, 'kind'),
    },
    ...(record.reason === undefined ? {} : { reason: readRequiredString(record.reason, 'reason') }),
    ...(record.ttlMs === undefined ? {} : { ttlMs: readInteger(record.ttlMs, 'ttlMs') }),
  };
}

export function normalizeHumanControlHoldId(id: string): string {
  const value = typeof id === 'string' ? id.trim() : '';
  if (!/^[a-zA-Z0-9._-]{1,128}$/.test(value)) {
    throw new AppError(
      'INVALID_ARGS',
      'Invalid human-control hold id. Use 1-128 chars: letters, numbers, dot, underscore, hyphen.',
    );
  }
  return value;
}

export function normalizeHumanControlHoldScope(
  scope: HumanControlHoldScope,
): HumanControlHoldScope {
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

export function normalizeHumanControlReason(reason: string | undefined): string | undefined {
  if (reason === undefined) return undefined;
  const value = reason.trim();
  if (!value) return undefined;
  if (value.length > 512) {
    throw new AppError('INVALID_ARGS', 'Human-control reason must be at most 512 characters.');
  }
  return value;
}

export function normalizeHumanControlTtlMs(ttlMs: number | undefined): number | undefined {
  if (ttlMs === undefined) return undefined;
  if (!Number.isInteger(ttlMs) || ttlMs < MIN_HOLD_TTL_MS || ttlMs > MAX_HOLD_TTL_MS) {
    throw new AppError(
      'INVALID_ARGS',
      `Human-control ttlMs must be between ${String(MIN_HOLD_TTL_MS)} and ${String(MAX_HOLD_TTL_MS)}.`,
    );
  }
  return ttlMs;
}

export function normalizeStoredHumanControlHold(raw: HumanControlHold): HumanControlHold {
  if (!raw || typeof raw !== 'object') {
    throw new AppError('COMMAND_FAILED', 'Persisted human-control hold is invalid.');
  }
  const createdAt = normalizeTimestamp(raw.createdAt, 'createdAt');
  const updatedAt = normalizeTimestamp(raw.updatedAt, 'updatedAt');
  const expiresAt =
    raw.expiresAt === undefined ? undefined : normalizeTimestamp(raw.expiresAt, 'expiresAt');
  const reason = normalizeHumanControlReason(raw.reason);
  return {
    id: normalizeHumanControlHoldId(raw.id),
    scope: normalizeHumanControlHoldScope(raw.scope),
    ...(reason ? { reason } : {}),
    createdAt,
    updatedAt,
    ...(expiresAt === undefined ? {} : { expiresAt }),
  };
}

function readRequiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new AppError('INVALID_ARGS', `Human-control ${field} must be a non-empty string.`);
  }
  return value;
}

function readOptionalStringField(
  record: Record<string, unknown>,
  key: 'deviceName' | 'platform' | 'kind',
): Partial<Record<typeof key, string>> {
  const value = record[key];
  if (value === undefined) return {};
  return { [key]: readRequiredString(value, `scope.${key}`) };
}

function readInteger(value: unknown, field: string): number {
  if (!Number.isInteger(value)) {
    throw new AppError('INVALID_ARGS', `Human-control ${field} must be an integer.`);
  }
  return Number(value);
}

function normalizeDeviceKey(deviceKey: string): string {
  const value = typeof deviceKey === 'string' ? deviceKey.trim() : '';
  if (!value || value.length > 256 || !/^[\x20-\x7E]+$/.test(value)) {
    throw new AppError('INVALID_ARGS', 'Invalid device key. Use 1-256 printable characters.');
  }
  return value;
}

function normalizeOptionalLabel(value: string | undefined, label: string): string | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim();
  if (!normalized || normalized.length > 256) {
    throw new AppError('INVALID_ARGS', `Invalid ${label}. Use 1-256 characters.`);
  }
  return normalized;
}

function normalizeTimestamp(value: number, field: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new AppError('COMMAND_FAILED', `Persisted human-control ${field} is invalid.`);
  }
  return value;
}
