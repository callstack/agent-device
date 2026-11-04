import { AppError, discloseDispatch } from '@agent-device/kernel/errors';
import type {
  Point,
  SnapshotAddressableNode,
  SnapshotNode,
  SnapshotState,
} from '@agent-device/kernel/snapshot';
import { normalizeRef } from '@agent-device/kernel/snapshot';
import { createSnapshotVisibility } from '@agent-device/contracts/snapshot';
import type { Platform } from '@agent-device/kernel/device';
import { INTERACTION_ERROR_REASONS } from './interaction-error.ts';
import { isDescendantOf, resolveInteractionTouchPoint } from './interaction-touch-point.ts';
import { isNodeEditable, isNodeVisible } from './internal/node.ts';

/**
 * The enabled, visible text fields inside `node`. A touch point treats a field as a competitor to
 * avoid, so a caller that means to focus a field has to ask for it by name.
 */
export function collectNestedTextFields(
  node: SnapshotNode,
  nodes: readonly SnapshotNode[],
  platform: Platform,
): SnapshotAddressableNode[] {
  const byIndex = new Map(nodes.map((entry) => [entry.index, entry]));
  return nodes.filter(
    (candidate): candidate is SnapshotAddressableNode =>
      candidate.ref !== undefined &&
      isDescendantOf(candidate, node, byIndex) &&
      isNodeEditable(candidate, platform) &&
      isNodeVisible(candidate),
  );
}

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
        competitorCount: resolution.competitorCount,
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
