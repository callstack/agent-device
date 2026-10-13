import type { Rect, SnapshotCoveringNode, SnapshotNode } from '@agent-device/kernel/snapshot';

/** Machine-readable `error.details.reason` values shared by interaction producers and adapters. */
export const INTERACTION_ERROR_REASONS = {
  selectorNotFound: 'selector_not_found',
  predicateFailed: 'predicate_failed',
  /**
   * An `@ref` names no node of the stored tree: stale, or never issued. `details.ref` carries the
   * bare ref body (`e12`), as `offscreen_ref` does. A consumer re-observes on this reason instead
   * of matching the message.
   */
  refNotFound: 'ref_not_found',
  /** An `@ref` names a listed node with no label to wait on or scope by; the tree is fresh. */
  refUnlabeled: 'ref_unlabeled',
  /** The target names a node with no usable centre to touch: a missing, non-finite, or negative rect. */
  targetBoundsInvalid: 'target_bounds_invalid',
  /**
   * A readiness poll captured a tree the snapshot-quality verdict calls sparse and the selector did
   * not resolve in it: the tree is untrustworthy, so absence proves nothing and the wait ends now.
   * `details.snapshotQuality` carries the verdict.
   */
  captureSparse: 'capture_sparse',
  /** The target resolved, but another visible element covers it. */
  targetCovered: 'target_covered',
} as const;

/** The part of a covered node a refusal reports. */
type CoveredNodeFacts = Pick<SnapshotNode, 'ref' | 'interactionBlocked' | 'coveredBy'>;

/**
 * The whole `error.details` shape of a covered refusal, shared by every producer (the interaction
 * runtime's `click`/`press`/`fill`/`focus` guard and `find ... focus`) so both paths report the same
 * reason, hint, ref and cover description. The hint names the cover when the occlusion scan found
 * one and stays generic when the cover has no name; `coveredBy` is absent in that case rather than
 * guessed. The cover is diagnosis only — the detail never carries its ref.
 */
export function coveredInteractionDetails(
  node: CoveredNodeFacts,
  subject: { selector?: string } = {},
): Record<string, unknown> {
  const coveredBy = node.coveredBy;
  return {
    reason: INTERACTION_ERROR_REASONS.targetCovered,
    hint: coveredInteractionHint(coveredBy),
    ...(subject.selector ? { selector: subject.selector } : {}),
    ref: `@${node.ref}`,
    interactionBlocked: node.interactionBlocked,
    ...(coveredBy ? { coveredBy } : {}),
  };
}

/**
 * The recovery hint a covered refusal publishes: what to dismiss when the occlusion scan named the
 * cover, the generic recovery when nothing nameable covered. Owned here rather than by the snapshot
 * presentation because a covered refusal is its only consumer, and this subpath's import closure is
 * its own module alone — reaching a snapshot module for one string would make every importer of the
 * reason vocabulary evaluate the snapshot presentation eagerly.
 */
function coveredInteractionHint(coveredBy: SnapshotCoveringNode | undefined): string {
  if (!coveredBy) {
    return 'Use a different visible target, scroll it clear of the overlay, or inspect with snapshot/screenshot before retrying.';
  }
  return (
    `Covered by ${describeCoverForHint(coveredBy)}. Dismiss or close that element, ` +
    'scroll the target clear of it, or inspect with snapshot/screenshot before retrying.'
  );
}

/**
 * One-line rendering of the cover, e.g. `the dialog "Cookie banner" at (16, 420 358x180)`;
 * coordinates are rounded while the detail payload keeps the unrounded rect. The label is
 * app-controlled text, so the rendering collapses whitespace and drops quote characters to keep the
 * hint one unambiguous line.
 */
function describeCoverForHint(cover: SnapshotCoveringNode): string {
  const named = describeCoverNameForHint(cover);
  const rect = cover.rect;
  return rect ? `the ${named} at ${describeRectForHint(rect)}` : `the ${named}`;
}

function describeCoverNameForHint(cover: SnapshotCoveringNode): string {
  const label = cover.label
    ? cover.label
        .replaceAll(/[\r\n]+/g, ' ')
        .replaceAll(/\s+/g, ' ')
        .replaceAll('"', '')
        .trim()
    : '';
  return label ? `${cover.kind} "${label}"` : cover.kind;
}

function describeRectForHint(rect: Rect): string {
  return (
    `(${Math.round(rect.x)}, ${Math.round(rect.y)} ` +
    `${Math.round(rect.width)}x${Math.round(rect.height)})`
  );
}
