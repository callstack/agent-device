import type {
  Rect,
  SnapshotAddressableNode,
  SnapshotCoveringNode,
} from '@agent-device/kernel/snapshot';
import type { ReasonTable } from '@agent-device/kernel/errors';

/**
 * Machine-readable `error.details.reason` values shared by interaction producers and adapters.
 *
 * Every value is a literal, and this module imports nothing: these codes are the vocabulary the
 * Maestro, replay, and host adapters read, and the eager-closure gate (`scripts/__tests__/
 * eager-closure-budgets.test.ts`) holds this leaf at the size it has — a shared constant imported
 * from a heavier package makes every façade that reads a reason evaluate that package.
 */
export const INTERACTION_ERROR_REASONS = {
  // No element matches the selector.
  selectorNotFound: { reason: 'selector_not_found' },
  // The element does not satisfy the asserted state, or strict absence could not be proven.
  predicateFailed: { reason: 'predicate_failed' },
  /**
   * An `@ref` names no node of the stored tree: stale, or never issued. `details.ref` carries the
   * bare ref body (`e12`), as `offscreen_ref` does. A consumer re-observes on this reason instead
   * of matching the message.
   */
  // The `@ref` names no node of the stored snapshot; take a new snapshot.
  refNotFound: { reason: 'ref_not_found' },
  /** An `@ref` names a listed node with no label to wait on or scope by; the tree is fresh. */
  // The `@ref` names a node with no label to wait on or scope by.
  refUnlabeled: { reason: 'ref_unlabeled' },
  /** The target names a node with no usable centre to touch: a missing, non-finite, or negative rect. */
  // The target has no usable center to touch.
  targetBoundsInvalid: { reason: 'target_bounds_invalid' },
  /** The target resolved, but another visible element covers it. */
  // Another visible element covers the target; `details.coveredBy` names it when known.
  targetCovered: { reason: 'target_covered' },
  /**
   * A press or click refused before dispatch because the platform reports the resolved control as
   * not hittable: a tap at its centre would land on another element. Distinct from
   * `target_covered`, which needs occlusion evidence; this reason carries none, so it names no
   * `coveredBy`. `details.selector` or `details.ref` names the target and `details.rect` is where
   * the command resolved it. The owner is
   * `packages/command-runtime/src/commands/interaction/runtime/pre-dispatch-admission.ts`.
   */
  // The platform reports the target as not hittable, so nothing was pressed.
  targetNotHittable: { reason: 'target_not_hittable' },
  /** `find focus` or `find type` resolved to a disabled text field, which `details.ref` names. */
  // `find focus` or `find type` resolved to a disabled text field.
  targetDisabled: { reason: 'target_disabled' },
  /**
   * A press or click refused because it could not confirm a resting position for its target: the
   * target's rect was still changing when the transition window after the session's last mutating
   * action ran out, or a re-observation could not measure the position at all. `details.selector` or
   * `details.ref` names the target, `details.rect` is where the command resolved it, and
   * `details.movedToRect` where the last re-observation found it — present only when that look
   * measured one. Branch on this reason, not the message: the recovery is to wait for the surface
   * and retry, never to retry the same point immediately. The owner is
   * `packages/command-runtime/src/commands/interaction/runtime/moving-target-gate.ts`, which raises the reason beside the
   * hint that names that recovery.
   */
  // The target did not come to rest before the press; wait for the screen, then retry.
  targetStillMoving: { reason: 'target_still_moving' },
  /**
   * Every tappable region of the target belongs to one of its interactive children, so a press on
   * the parent would land on a child control. `details.competitorRefs` names up to five of those
   * children and `details.competitorCount` counts them. The owner is
   * `packages/selectors/src/node-touch-point.ts`.
   */
  // Every tappable region of the target belongs to one of its interactive children.
  coveredByInteractiveDescendants: { reason: 'covered_by_interactive_descendants' },
  /**
   * The acting pipeline's off-screen stage refused a target named by selector: the resolved node
   * sits outside the screen, so nothing was pressed and `details.selector` names the target. The
   * owner is `packages/command-runtime/src/commands/interaction/runtime/target-visibility-stages.ts`.
   */
  // A selector resolved to an element outside the screen, so nothing was pressed.
  offscreenSelector: { reason: 'offscreen_selector' },
  /**
   * The acting pipeline's off-screen stage refused a target named by `@ref`: the resolved node sits
   * outside the screen, so nothing was pressed and `details.ref` names it. The owner is
   * `packages/command-runtime/src/commands/interaction/runtime/target-visibility-stages.ts`.
   */
  // An @ref resolved to an element outside the screen, so nothing was pressed.
  offscreenRef: { reason: 'offscreen_ref' },
} as const satisfies ReasonTable<'interaction'>;

/** The part of a covered node a refusal reports. */
type CoveredNodeFacts = Pick<SnapshotAddressableNode, 'ref' | 'interactionBlocked' | 'coveredBy'>;

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
    reason: INTERACTION_ERROR_REASONS.targetCovered.reason,
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
  if (coveredBy.persistentBar) {
    return (
      `Covered by ${describeCoverForHint(coveredBy)}. Use a different visible target, ` +
      'or inspect with snapshot/screenshot before retrying.'
    );
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
