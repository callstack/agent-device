import { AppError } from '@agent-device/kernel/errors';
import type { SnapshotSourceLimits } from './types.ts';

const FRAME_HEADER_BYTES = 4;
const MAXIMUM_FRAME_BYTES = 16 * 1024 * 1024;
const MAXIMUM_DURATION_MS = 120_000;
// Mirrors the native bridge's kMaximumDepth.
const MAXIMUM_DEPTH = 128;
// Mirrors the native bridge's kMaximumRequestLevels: one native request reads at most this many
// levels, and deeper levels arrive through continuations.
export const MAXIMUM_REQUEST_LEVELS = 65;
const MAXIMUM_NODES = 10_000;

export const DEFAULT_SNAPSHOT_SOURCE_LIMITS: SnapshotSourceLimits = Object.freeze({
  maxRequestBytes: 64 * 1024,
  maxResponseBytes: 4 * 1024 * 1024,
  maxNodes: 5000,
  // The bridge reads past the AX server's per-request depth limit through continuations, so a
  // regular capture asks for every level it can deliver; a lower default hides deep controls.
  maxTraversalDepth: MAXIMUM_DEPTH,
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
    limits.maxRequestBytes > MAXIMUM_FRAME_BYTES ||
    limits.maxResponseBytes > MAXIMUM_FRAME_BYTES
  ) {
    throw new AppError('INVALID_ARGS', 'Snapshot source frame limits exceed the bridge bound', {
      maxRequestBytes: limits.maxRequestBytes,
      maxResponseBytes: limits.maxResponseBytes,
      maximumFrameBytes: MAXIMUM_FRAME_BYTES,
    });
  }
  if (limits.maxNodes > MAXIMUM_NODES || limits.maxTraversalDepth > MAXIMUM_DEPTH) {
    throw new AppError('INVALID_ARGS', 'Snapshot source tree limits exceed the bridge bound', {
      maxNodes: limits.maxNodes,
      maxTraversalDepth: limits.maxTraversalDepth,
      maximumNodes: MAXIMUM_NODES,
      maximumDepth: MAXIMUM_DEPTH,
    });
  }
  if (limits.maxDurationMs > MAXIMUM_DURATION_MS) {
    throw new AppError('INVALID_ARGS', 'Snapshot source duration exceeds the bridge bound', {
      maxDurationMs: limits.maxDurationMs,
      maximumDurationMs: MAXIMUM_DURATION_MS,
    });
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
