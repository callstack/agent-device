import type { Rect, SnapshotNode } from '@agent-device/kernel/snapshot';
import { normalizeRect } from '@agent-device/kernel/rect-center';
import { isSemanticTouchTarget } from './touch-semantics.ts';

/** One control reported through a wrapper differs by under a point per edge:
 * a 36 pt toolbar button reports as 35 pt at x + 0.667 on iOS. */
const WRAPPER_RECT_SLACK = 1;

/**
 * The control of a single ancestry chain that is one actionable control wrapped
 * by non-actionable wrappers, or null when the chain does not denote one
 * control.
 *
 * Regular iOS snapshots omit unverified hittability, and
 * `findPreferredActionableDescendant` requires verified hittability, so a
 * SwiftUI wrapper can never relate to its own control through the resolution
 * ladder: press and wait then see two actionable elements for one toolbar
 * button. The collapse stays narrow on purpose: every candidate above the
 * control must be a non-actionable wrapper, so a chain of two real controls (a
 * cell and the button inside it) keeps the existing ambiguity refusal instead of
 * silently pressing the descendant. Candidates carrying any hittability fact
 * also keep the existing rules.
 */
export function resolveUnverifiedWrapperControl(
  candidates: readonly SnapshotNode[],
): SnapshotNode | null {
  if (candidates.length < 2) return null;
  if (candidates.some((candidate) => candidate.hittable !== undefined)) return null;
  const control = candidates.reduce((deepest, candidate) =>
    (candidate.depth ?? 0) > (deepest.depth ?? 0) ? candidate : deepest,
  );
  if (!isSemanticTouchTarget(control)) return null;
  const wrapsOnlyNonActionable = candidates.every(
    (candidate) => candidate === control || !isSemanticTouchTarget(candidate),
  );
  if (!wrapsOnlyNonActionable) return null;
  const controlRect = normalizeRect(control.rect);
  if (!controlRect) return null;
  return candidates.every((candidate) =>
    agreesWithinWrapperSlack(normalizeRect(candidate.rect), controlRect),
  )
    ? control
    : null;
}

function agreesWithinWrapperSlack(rect: Rect | null, controlRect: Rect): boolean {
  if (!rect) return false;
  return (
    Math.abs(rect.x - controlRect.x) <= WRAPPER_RECT_SLACK &&
    Math.abs(rect.y - controlRect.y) <= WRAPPER_RECT_SLACK &&
    Math.abs(rect.width - controlRect.width) <= WRAPPER_RECT_SLACK &&
    Math.abs(rect.height - controlRect.height) <= WRAPPER_RECT_SLACK
  );
}
