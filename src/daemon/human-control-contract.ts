import type {
  HumanControlHold,
  HumanControlHoldOptions,
  HumanControlHoldScope,
} from '@agent-device/contracts/client';
import { AppError } from '@agent-device/kernel/errors';
import {
  normalizeDeviceKey,
  normalizeLeaseBackend,
  normalizeLeaseProvider,
} from './lease-registry-scope.ts';

export const HUMAN_CONTROL_HTTP_PREFIX = '/admin/human-control/holds';

export type HumanControlHoldInput = HumanControlHoldOptions & {
  scope?: HumanControlHoldScope;
};

export type HumanControlAuthority = { kind: 'host' } | { kind: 'lease'; leaseId: string };

export function parseHumanControlHoldInput(value: unknown): HumanControlHoldInput {
  const record = readHumanControlRecord(value, 'Human-control request body');
  const reason = record.reason;
  if (reason !== undefined && (typeof reason !== 'string' || reason.trim().length > 512)) {
    throw new AppError('INVALID_ARGS', 'Human-control reason must be at most 512 characters.');
  }
  const ttlMs = record.ttlMs;
  if (
    ttlMs !== undefined &&
    (typeof ttlMs !== 'number' || !Number.isInteger(ttlMs) || ttlMs < 1_000 || ttlMs > 86_400_000)
  ) {
    throw new AppError('INVALID_ARGS', 'Human-control ttlMs must be between 1000 and 86400000.');
  }
  return {
    ...(record.scope === undefined ? {} : { scope: parseHumanControlScope(record.scope) }),
    ...(typeof reason === 'string' && reason.trim() ? { reason: reason.trim() } : {}),
    ...(typeof ttlMs === 'number' ? { ttlMs } : {}),
  };
}

function parseHumanControlScope(value: unknown): HumanControlHoldScope {
  const scope = readHumanControlRecord(value, 'Host human-control scope');
  if (
    typeof scope.backend !== 'string' ||
    !scope.backend.trim() ||
    typeof scope.deviceKey !== 'string'
  ) {
    throw new AppError(
      'INVALID_ARGS',
      'Host human control requires scope.backend and scope.deviceKey.',
    );
  }
  if (scope.leaseProvider !== undefined && typeof scope.leaseProvider !== 'string') {
    throw new AppError('INVALID_ARGS', 'scope.leaseProvider must be a string.');
  }
  const leaseProvider = normalizeLeaseProvider(scope.leaseProvider);
  return {
    backend: normalizeLeaseBackend(scope.backend),
    deviceKey: normalizeDeviceKey(scope.deviceKey)!,
    ...(leaseProvider ? { leaseProvider } : {}),
  };
}

function readHumanControlRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AppError('INVALID_ARGS', `${label} must be an object.`);
  }
  return value as Record<string, unknown>;
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

export function cloneHumanControlHold(hold: HumanControlHold): HumanControlHold {
  return { ...hold, scope: { ...hold.scope } };
}

export function humanControlActiveError(hold: HumanControlHold): AppError {
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
