import { AppError, discloseDispatch } from '@agent-device/kernel/errors';
import type {
  Point,
  SnapshotAddressableNode,
  SnapshotNode,
  SnapshotState,
} from '@agent-device/kernel/snapshot';
import { normalizeRef } from '@agent-device/kernel/snapshot';
import { createSnapshotVisibility, isFillableType } from '@agent-device/contracts/snapshot';
import type { Platform } from '@agent-device/kernel/device';
import { INTERACTION_ERROR_REASONS } from './interaction-error.ts';
import { isDescendantOf, resolveInteractionTouchPoint } from './interaction-touch-point.ts';

export type FocusTarget =
  | { kind: 'target'; node: SnapshotAddressableNode }
  | { kind: 'disabled-field'; node: SnapshotAddressableNode }
  | { kind: 'several-fields'; fields: SnapshotAddressableNode[] };

/**
 * What an action that means to focus a text field should aim at. A touch point treats a field as a
 * competitor to avoid, so this has to run first. The field the locator named wins over anything its
 * promoted ancestor contains; otherwise the ancestor's outermost on-screen fields decide.
 */
export function resolveFocusTarget(input: {
  located: SnapshotNode;
  resolved: SnapshotAddressableNode;
  nodes: readonly SnapshotNode[];
  platform: Platform;
}): FocusTarget {
  const { located, resolved, nodes, platform } = input;
  if (isAddressable(located) && isTextField(located, platform)) {
    return located.enabled === false
      ? { kind: 'disabled-field', node: located }
      : { kind: 'target', node: located };
  }
  const fields = collectOutermostTextFields(resolved, nodes, platform);
  const enabled = fields.filter((field) => field.enabled !== false);
  if (enabled.length > 1) return { kind: 'several-fields', fields: enabled };
  if (enabled[0]) return { kind: 'target', node: enabled[0] };
  return fields[0]
    ? { kind: 'disabled-field', node: fields[0] }
    : { kind: 'target', node: resolved };
}

function collectOutermostTextFields(
  node: SnapshotNode,
  nodes: readonly SnapshotNode[],
  platform: Platform,
): SnapshotAddressableNode[] {
  const byIndex = new Map(nodes.map((entry) => [entry.index, entry]));
  const visibility = createSnapshotVisibility([...nodes]);
  const fields = nodes.filter(
    (candidate): candidate is SnapshotAddressableNode =>
      isAddressable(candidate) &&
      isTextField(candidate, platform) &&
      isDescendantOf(candidate, node, byIndex) &&
      visibility.isVisibleOnScreen(candidate),
  );
  return fields.filter((field) => !fields.some((other) => isDescendantOf(field, other, byIndex)));
}

function isAddressable(node: SnapshotNode): node is SnapshotAddressableNode {
  return node.ref !== undefined;
}

/** An untyped node is lenient for a fill guard, but here being a field would make it the target. */
function isTextField(node: SnapshotNode, platform: Platform): boolean {
  return node.editable ?? (Boolean(node.type?.trim()) && isFillableType(node.type ?? '', platform));
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
