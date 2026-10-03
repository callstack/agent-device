import { AppError, discloseDispatch } from '@agent-device/kernel/errors';
import type { Point, SnapshotNode, SnapshotState } from '@agent-device/kernel/snapshot';
import { normalizeRef } from '@agent-device/kernel/snapshot';
import { createSnapshotVisibility } from '@agent-device/contracts/snapshot';
import { INTERACTION_ERROR_REASONS } from '@agent-device/selectors/interaction-error';
import { resolveInteractionTouchPoint } from '@agent-device/selectors/interaction-touch-point';

export function resolveNodeTouchPoint(
  node: SnapshotNode,
  nodes: SnapshotState['nodes'],
  failure: {
    invalidMessage: string;
    blockedTargetLabel: string;
    blockedTargetDetails: { ref: string } | { selector: string };
  },
): Point {
  const visibility = createSnapshotVisibility(nodes);
  const effectiveViewport = visibility.resolveEffectiveViewport(node);
  const rootViewport = node.rect ? visibility.resolveViewport(node.rect) : null;
  const resolution = resolveInteractionTouchPoint(nodes, node, {
    bounds: [effectiveViewport, rootViewport].filter((rect) => rect !== null),
  });
  if (resolution.kind === 'resolved') return resolution.point;
  if (resolution.kind === 'invalid') {
    throw discloseDispatch(
      new AppError('COMMAND_FAILED', failure.invalidMessage, {
        reason: INTERACTION_ERROR_REASONS.targetBoundsInvalid,
        ...bareTargetDetails(failure.blockedTargetDetails),
      }),
      'no',
    );
  }
  throw discloseDispatch(
    new AppError(
      'COMMAND_FAILED',
      `${failure.blockedTargetLabel} has no parent-owned touch point outside its interactive descendants`,
      {
        reason: 'covered_by_interactive_descendants',
        ...failure.blockedTargetDetails,
        competitorRefs: resolution.competitorRefs.slice(0, 5).map((ref) => `@${ref}`),
        competitorCount: resolution.competitorRefs.length,
        hint: 'Tap the specific interactive child you intend, or use a more specific selector. Every safely tappable region of the parent belongs to one of its child controls.',
      },
    ),
    'no',
  );
}

/** `details.ref` is the bare ref body on every reason; the blocked-target label keeps its `@`. */
function bareTargetDetails(
  details: { ref: string } | { selector: string },
): { ref: string } | { selector: string } {
  return 'ref' in details ? { ref: normalizeRef(details.ref) ?? details.ref } : details;
}
