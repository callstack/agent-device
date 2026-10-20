import type { SnapshotQualityState, SnapshotQualityVerdict } from '@agent-device/kernel/snapshot';
import { SNAPSHOT_QUALITY_BACKEND_CAPABILITIES } from './snapshot-quality-backend-capabilities.ts';

/**
 * The verdict names this version can speak, keyed against the kernel unions so a map cannot fall
 * behind one. They cannot be one shared kernel predicate: this module's eager closure is frozen at
 * its merge-base size (#2872). The strategies need no map — `SNAPSHOT_QUALITY_BACKEND_CAPABILITIES`
 * is already keyed by exactly those names.
 */
const DECLARED_STATES: Record<SnapshotQualityState, true> = {
  healthy: true,
  recovered: true,
  sparse: true,
};

const DECLARED_REASON_CODES: Record<NonNullable<SnapshotQualityVerdict['reasonCode']>, true> = {
  'ax-rejected': true,
  'sparse-tree': true,
  budget: true,
  'no-nodes': true,
  'capture-failed': true,
  'presentation-failed': true,
  deferred: true,
  'requested-backend': true,
};

function isDeclared<Key extends string, Value>(
  vocabulary: Record<Key, Value>,
  value: unknown,
): value is Key {
  return typeof value === 'string' && Object.hasOwn(vocabulary, value);
}

export function readSnapshotQualityVerdict(value: unknown): SnapshotQualityVerdict | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>;
  // Validate the load-bearing union fields: an object with an unknown state/backend is not a
  // verdict this version understands, so it falls through as verdict-absent and the legacy
  // node-shape detectors run instead of being silently suppressed by a malformed payload.
  if (
    !isDeclared(DECLARED_STATES, raw.state) ||
    !isDeclared(SNAPSHOT_QUALITY_BACKEND_CAPABILITIES, raw.backend)
  ) {
    return undefined;
  }
  const timing = readSnapshotQualityTiming(raw.timing);
  const notes = readSnapshotQualityNotes(raw.notes);
  return {
    state: raw.state,
    backend: raw.backend,
    reason: typeof raw.reason === 'string' ? raw.reason : undefined,
    // An unknown reasonCode is dropped, not rejected: a forward-version runner that adds one
    // still yields a usable verdict (only the budget-specific wording is keyed off it).
    reasonCode: isDeclared(DECLARED_REASON_CODES, raw.reasonCode) ? raw.reasonCode : undefined,
    customActions: readCustomActionCoverage(raw.customActions),
    effectiveDepth: typeof raw.effectiveDepth === 'number' ? raw.effectiveDepth : undefined,
    collapsedLeafIndexes: Array.isArray(raw.collapsedLeafIndexes)
      ? raw.collapsedLeafIndexes.filter((entry): entry is number => typeof entry === 'number')
      : undefined,
    ...(timing ? { timing } : {}),
    ...(notes ? { notes } : {}),
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

function readSnapshotQualityNotes(value: unknown): SnapshotQualityVerdict['notes'] {
  if (!Array.isArray(value)) return undefined;
  const notes: NonNullable<SnapshotQualityVerdict['notes']> = [];
  for (const entry of value.slice(0, 1)) {
    if (!entry || typeof entry !== 'object') continue;
    const raw = entry as Record<string, unknown>;
    if (raw.code !== 'regular-geometry-clipped') continue;
    if (
      typeof raw.clippedNodeCount !== 'number' ||
      !Number.isSafeInteger(raw.clippedNodeCount) ||
      raw.clippedNodeCount < 0 ||
      typeof raw.droppedNodeCount !== 'number' ||
      !Number.isSafeInteger(raw.droppedNodeCount) ||
      raw.droppedNodeCount < 0 ||
      raw.clippedNodeCount + raw.droppedNodeCount === 0
    )
      continue;
    notes.push({
      code: raw.code,
      clippedNodeCount: raw.clippedNodeCount,
      droppedNodeCount: raw.droppedNodeCount,
    });
  }
  return notes.length > 0 ? notes : undefined;
}
