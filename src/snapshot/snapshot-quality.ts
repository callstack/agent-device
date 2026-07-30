import type { SnapshotNode, SnapshotQualityVerdict } from '@agent-device/kernel/snapshot';

// The type lives in snapshot.ts (the foundational type module) to avoid a cyclic
// import with SnapshotNode; re-exported here so existing callers are unaffected.
export type { SnapshotQualityVerdict } from '@agent-device/kernel/snapshot';

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
    return [
      `Detected an overly complex or slow accessibility tree. Fell back to the ${verdict.backend} snapshot backend. It is OK to continue; use --json to inspect snapshotQuality.reason if you need recovery details.`,
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
    `Some deeper accessibility nodes were omitted; this tree is capped at depth ${verdict.effectiveDepth}. Re-run with --depth ${verdict.effectiveDepth} --scope <container> only if you need deeper content.`,
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

/**
 * The Android helper's content-recovery verdicts: the capture mechanism
 * worked but judged the current screen's CONTENT unreadable. The single
 * enumeration behind both `AndroidHelperContentRecoveryDecision['reason']`
 * (`src/platforms/android/snapshot-content-recovery.ts` derives its union
 * from this list) and `isUnreadableCaptureContentError` below, so a new
 * content verdict cannot be added to one without the other.
 */
const ANDROID_CONTENT_RECOVERY_REASONS = [
  'empty-helper-output',
  'system-window-only',
  'content-poor-app-window',
] as const;

export type AndroidContentRecoveryReason = (typeof ANDROID_CONTENT_RECOVERY_REASONS)[number];

const ANDROID_CONTENT_RECOVERY_REASON_SET: ReadonlySet<string> = new Set(
  ANDROID_CONTENT_RECOVERY_REASONS,
);

/**
 * True when a thrown capture failure is a CONTENT verdict — the capture
 * mechanism worked but judged the current screen unreadable (the Android
 * helper's content-recovery refusals) — rather than a mechanism failure. A
 * polling wait rides these out exactly like a sparse-verdict capture that
 * returned no match (iOS already yields a verdict instead of throwing): a
 * mid-transition screen is the state a wait exists to wait through. One-shot
 * reads keep failing loudly, and a wait whose screen never becomes readable
 * rethrows the capture failure at its deadline instead of masking it as a
 * generic timeout.
 *
 * Matches ONLY the enumerated content-recovery reasons: Android stamps
 * `androidSnapshotHelperFailureReason` on mechanism failures too (helper
 * timeouts, adb failures, a missing helper artifact — with free-form reason
 * strings), and those must keep failing a wait immediately rather than being
 * polled until its deadline.
 */
export function isUnreadableCaptureContentError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const details = (error as { details?: Record<string, unknown> }).details;
  const reason = details?.androidSnapshotHelperFailureReason;
  return typeof reason === 'string' && ANDROID_CONTENT_RECOVERY_REASON_SET.has(reason);
}
