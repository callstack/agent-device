import type { SnapshotNode, SnapshotQualityVerdict } from './snapshot.ts';

// The type lives in snapshot.ts (the foundational type module) to avoid a cyclic
// import with SnapshotNode; re-exported here so existing callers are unaffected.
export type { SnapshotQualityVerdict } from './snapshot.ts';

const SNAPSHOT_QUALITY_STATES = new Set<SnapshotQualityVerdict['state']>([
  'healthy',
  'recovered',
  'sparse',
]);
const SNAPSHOT_QUALITY_BACKENDS = new Set<SnapshotQualityVerdict['backend']>([
  'tree',
  'queries',
  'private-ax',
]);
const SNAPSHOT_QUALITY_REASON_CODES = new Set<NonNullable<SnapshotQualityVerdict['reasonCode']>>([
  'ax-rejected',
  'sparse-tree',
  'budget',
  'no-nodes',
  'capture-failed',
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
    effectiveDepth: typeof raw.effectiveDepth === 'number' ? raw.effectiveDepth : undefined,
    collapsedLeafIndexes: Array.isArray(raw.collapsedLeafIndexes)
      ? raw.collapsedLeafIndexes.filter((entry): entry is number => typeof entry === 'number')
      : undefined,
  };
}

export function isSparseSnapshotQualityVerdict(
  verdict: SnapshotQualityVerdict | undefined,
): verdict is SnapshotQualityVerdict {
  return verdict?.state === 'sparse';
}

/** Canonical warning lines for a verdict; the single place degradation is worded. */
export function renderSnapshotQualityWarnings(
  verdict: SnapshotQualityVerdict,
  nodes: Pick<SnapshotNode, 'index' | 'ref' | 'type' | 'identifier' | 'label'>[],
): string[] {
  return [
    ...stateWarning(verdict),
    ...depthWarning(verdict),
    ...collapsedLeafWarnings(verdict, nodes),
  ];
}

function stateWarning(verdict: SnapshotQualityVerdict): string[] {
  if (verdict.state === 'recovered') {
    const meaning =
      verdict.reasonCode === 'budget'
        ? ' The primary capture ran out of its time budget (busy app or simulator); the recovered tree is authoritative for this screen.'
        : " This usually means the app publishes an unhealthy accessibility tree — fixing the app's accessibility is the real cure. Treat screenshot as visual truth when this warning appears.";
    return [
      `Recovered this snapshot with the ${verdict.backend} accessibility backend` +
        (verdict.reason ? ` after: ${verdict.reason}.` : '.') +
        meaning,
    ];
  }
  if (verdict.state === 'sparse') {
    return [
      'No snapshot backend could read this screen' +
        (verdict.reason ? ` (${verdict.reason})` : '') +
        '. Use screenshot as visual truth and coordinate taps; retry snapshot after navigating.',
    ];
  }
  return [];
}

function depthWarning(verdict: SnapshotQualityVerdict): string[] {
  if (verdict.effectiveDepth === undefined) return [];
  return [
    `The accessibility server rejected deeper requests; this tree is capped at depth ${verdict.effectiveDepth} — re-run with --depth ${verdict.effectiveDepth} --scope <container> for deeper content.`,
  ];
}

function collapsedLeafWarnings(
  verdict: SnapshotQualityVerdict,
  nodes: Pick<SnapshotNode, 'index' | 'ref' | 'type' | 'identifier' | 'label'>[],
): string[] {
  const warnings: string[] = [];
  for (const index of verdict.collapsedLeafIndexes ?? []) {
    const node = nodes.find((entry) => entry.index === index);
    if (!node) continue;
    const name = node.identifier ? ` (${node.identifier})` : '';
    warnings.push(
      `@${node.ref} [${node.type ?? 'element'}]${name} merges many labels into a single accessibility element. The app likely marks a container as accessible, which hides every descendant from assistive tech and automation — the children cannot be addressed individually. Fix the app's accessibility (mark the rows, not the container); until then use screenshot as visual truth and coordinate taps.`,
    );
  }
  return warnings;
}
