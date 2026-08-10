import type { SnapshotNode, SnapshotQualityVerdict } from '@agent-device/kernel/snapshot';

// The type lives in snapshot.ts (the foundational type module) to avoid a cyclic
// import with SnapshotNode; re-exported here so existing callers are unaffected.

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

/** Canonical warning lines for a verdict; the single place degradation is worded. */
export function renderSnapshotQualityWarnings(
  verdict: SnapshotQualityVerdict,
  nodes: Pick<SnapshotNode, 'index' | 'ref' | 'type' | 'identifier' | 'label'>[],
): string[] {
  return [
    ...stateWarning(verdict),
    ...customActionCoverageWarning(verdict),
    ...depthWarning(verdict),
    ...collapsedLeafWarnings(verdict, nodes),
  ];
}

/**
 * Disclosed at response level, once, and only when the pass was incomplete: a
 * merged element the bounded pass never reached renders exactly like one with
 * no custom actions, so staying silent would teach the reader that the rest of
 * the list has no affordances — the mis-inference `--actions` exists to stop.
 *
 * The remedy is scrolling, not `--scope`: the runner reads on-screen elements
 * first, and scope is applied after the read pass, so it cannot redirect the
 * budget.
 */
function customActionCoverageWarning(verdict: SnapshotQualityVerdict): string[] {
  const coverage = verdict.customActions;
  if (!coverage) return [];
  const lines: string[] = [];
  if (coverage.blocked) {
    // Not a budget stop, so it must not borrow the budget stop's remedy:
    // scrolling cannot clear a hung read, and telling the reader to try would
    // send them in circles.
    lines.push(
      'Custom actions were not read: an earlier accessibility read is still hung, so this capture skipped the read pass instead of queueing behind it. No element’s actions list is authoritative here. Reads resume once that call returns.',
    );
  } else if (coverage.read < coverage.candidates) {
    lines.push(
      `Custom actions were read for ${coverage.read} of ${coverage.candidates} merged elements, on-screen ones first; the remaining ${coverage.candidates - coverage.read} were not read, so an absent actions list on those is not evidence that they have none. Scroll them into view and re-run to read them.`,
    );
  }
  if (coverage.truncated > 0) {
    // A clipped list looks complete, which is the same failure mode as an
    // unread element, so it gets its own line rather than a silent cap.
    lines.push(
      `${coverage.truncated} element(s) published more custom actions than are shown; those lists are clipped to the first 8 names, and long names are shortened.`,
    );
  }
  return lines;
}

/**
 * The full recovered-state warning line. Shared with the daemon's one-shot deferred
 * latch (`src/daemon/snapshot-quality-latch.ts`), which re-renders it exactly once when
 * the penalty was armed by an internal capture that never reached the user.
 */
export function recoveredSnapshotQualityWarning(
  backend: SnapshotQualityVerdict['backend'],
): string {
  return `Detected an overly complex or slow accessibility tree. Fell back to the ${backend} snapshot backend. It is OK to continue; use --json to inspect snapshotQuality.reason if you need recovery details.`;
}

function stateWarning(verdict: SnapshotQualityVerdict): string[] {
  if (verdict.state === 'recovered') {
    // Penalty-deferred captures repeat on every capture of a hostile screen, so the full
    // warning is suppressed here. When the capture that ARMED the penalty was internal
    // (selector resolution, settle observation, system-modal probe) and never rendered it,
    // the daemon's session latch re-renders the warning once at the response seam.
    if (verdict.reasonCode === 'deferred' || verdict.reasonCode === 'requested-backend') return [];
    return [recoveredSnapshotQualityWarning(verdict.backend)];
  }
  if (verdict.state === 'sparse') {
    return [
      'No snapshot backend could read this screen' +
        (verdict.reason ? ` (${verdict.reason})` : '') +
        '. Its refs and selectors are invalid. Use screenshot as visual truth and coordinate taps; retry snapshot after navigating.',
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
