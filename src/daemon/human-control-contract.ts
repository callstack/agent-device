import { AppError } from '@agent-device/kernel/errors';

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
