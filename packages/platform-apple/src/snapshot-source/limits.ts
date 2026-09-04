import { AppError } from '@agent-device/kernel/errors';
import type { SnapshotSourceLimits } from './types.ts';

const FRAME_HEADER_BYTES = 4;

export const DEFAULT_SNAPSHOT_SOURCE_LIMITS: SnapshotSourceLimits = Object.freeze({
  maxRequestBytes: 64 * 1024,
  maxResponseBytes: 4 * 1024 * 1024,
  maxNodes: 1500,
  maxTraversalDepth: 64,
  maxDurationMs: 5_000,
});

export function resolveSnapshotSourceLimits(
  overrides: Partial<SnapshotSourceLimits> | undefined,
): SnapshotSourceLimits {
  const limits = { ...DEFAULT_SNAPSHOT_SOURCE_LIMITS, ...(overrides ?? {}) };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new AppError(
        'INVALID_ARGS',
        `Snapshot source limit ${name} must be a positive integer`,
        {
          name,
          value,
        },
      );
    }
  }
  if (limits.maxRequestBytes > limits.maxResponseBytes) {
    throw new AppError(
      'INVALID_ARGS',
      'Snapshot source request bytes cannot exceed response bytes',
      {
        maxRequestBytes: limits.maxRequestBytes,
        maxResponseBytes: limits.maxResponseBytes,
      },
    );
  }
  if (
    limits.maxRequestBytes <= FRAME_HEADER_BYTES ||
    limits.maxResponseBytes <= FRAME_HEADER_BYTES
  ) {
    throw new AppError('INVALID_ARGS', 'Snapshot source frame limits must leave room for a body', {
      maxRequestBytes: limits.maxRequestBytes,
      maxResponseBytes: limits.maxResponseBytes,
    });
  }
  return Object.freeze(limits);
}
