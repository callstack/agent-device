import type { SnapshotQualityVerdict } from '@agent-device/kernel/snapshot';
import { SNAPSHOT_QUALITY_BACKEND_CAPABILITIES } from './backend-capabilities.ts';

const SNAPSHOT_QUALITY_STATES = new Set<SnapshotQualityVerdict['state']>([
  'healthy',
  'recovered',
  'sparse',
]);
const SNAPSHOT_QUALITY_BACKENDS = new Set<SnapshotQualityVerdict['backend']>(
  Object.keys(SNAPSHOT_QUALITY_BACKEND_CAPABILITIES) as SnapshotQualityVerdict['backend'][],
);
const SNAPSHOT_QUALITY_REASON_CODES = new Set<NonNullable<SnapshotQualityVerdict['reasonCode']>>([
  'ax-rejected',
  'sparse-tree',
  'budget',
  'no-nodes',
  'capture-failed',
  'presentation-failed',
  'deferred',
  'requested-backend',
]);

export function readSnapshotQualityVerdict(value: unknown): SnapshotQualityVerdict | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>;
  // Validate the load-bearing union fields: an object with an unknown state/backend is not a
  // verdict this version understands, so it falls through as verdict-absent and the legacy
  // node-shape detectors run instead of being silently suppressed by a malformed payload.
  if (
    typeof raw.state !== 'string' ||
    !SNAPSHOT_QUALITY_STATES.has(raw.state as SnapshotQualityVerdict['state'])
  ) {
    return undefined;
  }
  if (
    typeof raw.backend !== 'string' ||
    !SNAPSHOT_QUALITY_BACKENDS.has(raw.backend as SnapshotQualityVerdict['backend'])
  ) {
    return undefined;
  }
  const timing = readSnapshotQualityTiming(raw.timing);
  return {
    state: raw.state as SnapshotQualityVerdict['state'],
    backend: raw.backend as SnapshotQualityVerdict['backend'],
    reason: typeof raw.reason === 'string' ? raw.reason : undefined,
    // An unknown reasonCode is dropped, not rejected: a forward-version runner that adds one
    // still yields a usable verdict (only the budget-specific wording is keyed off it).
    reasonCode:
      typeof raw.reasonCode === 'string' &&
      SNAPSHOT_QUALITY_REASON_CODES.has(
        raw.reasonCode as NonNullable<SnapshotQualityVerdict['reasonCode']>,
      )
        ? (raw.reasonCode as SnapshotQualityVerdict['reasonCode'])
        : undefined,
    customActions: readCustomActionCoverage(raw.customActions),
    effectiveDepth: typeof raw.effectiveDepth === 'number' ? raw.effectiveDepth : undefined,
    collapsedLeafIndexes: Array.isArray(raw.collapsedLeafIndexes)
      ? raw.collapsedLeafIndexes.filter((entry): entry is number => typeof entry === 'number')
      : undefined,
    ...(timing ? { timing } : {}),
  };
}

function readSnapshotQualityTiming(value: unknown): SnapshotQualityVerdict['timing'] | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>;
  if (typeof raw.acquisitionMs !== 'number' || typeof raw.presentationMs !== 'number') {
    return undefined;
  }
  return {
    acquisitionMs: raw.acquisitionMs,
    presentationMs: raw.presentationMs,
  };
}

/**
 * A partial verdict is dropped rather than half-read: the whole point of the
 * pair is the ratio, and a coverage object missing one side cannot express one.
 */
function readCustomActionCoverage(
  value: unknown,
): SnapshotQualityVerdict['customActions'] | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>;
  if (typeof raw.read !== 'number' || typeof raw.candidates !== 'number') return undefined;
  // read/candidates are the ratio and must both be present; the truncation
  // count is additive, so an older runner that omits it reads as zero rather
  // than voiding the whole coverage.
  return {
    read: raw.read,
    candidates: raw.candidates,
    truncated: typeof raw.truncated === 'number' ? raw.truncated : 0,
    blocked: raw.blocked === true,
  };
}

export function isSparseSnapshotQualityVerdict(
  verdict: SnapshotQualityVerdict | undefined,
): verdict is SnapshotQualityVerdict {
  return verdict?.state === 'sparse';
}

export function preferredSnapshotBackendForVerdict(
  verdict: SnapshotQualityVerdict | undefined,
): 'private-ax' | undefined {
  return verdict?.backend === 'private-ax' ? 'private-ax' : undefined;
}
