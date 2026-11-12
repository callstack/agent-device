import { AppError, discloseDispatch } from '@agent-device/kernel/errors';
import type { Point, SnapshotAddressableNode, SnapshotNode } from '@agent-device/kernel/snapshot';
import type { SnapshotState } from '@agent-device/contracts/snapshot-model';
import { normalizeRect } from '@agent-device/kernel/rect-center';
import { normalizeRef } from '@agent-device/kernel/snapshot';
import {
  createSnapshotVisibility,
  isFillableType,
  isScrollableNodeLike,
} from '@agent-device/contracts/snapshot';
import type { Platform } from '@agent-device/kernel/device';
import { INTERACTION_ERROR_REASONS } from './interaction-error.ts';
import { isDescendantOf, resolveInteractionTouchPoint } from './interaction-touch-point.ts';

export type FocusTarget =
  | { kind: 'target'; node: SnapshotAddressableNode }
  | { kind: 'disabled-field'; node: SnapshotAddressableNode }
  | { kind: 'several-fields'; fields: SnapshotAddressableNode[] };

/**
 * What an action that means to focus a text field should aim at. A touch point treats a field as a
 * competitor to avoid, so this has to run first. The field the locator named, or the one holding what
 * it named, wins over anything the promoted match contains; otherwise the match's outermost on-screen
 * fields decide.
 */
export function resolveFocusTarget(input: {
  located: SnapshotNode;
  resolved: SnapshotAddressableNode;
  nodes: readonly SnapshotNode[];
  platform: Platform;
}): FocusTarget {
  const { located, resolved, nodes, platform } = input;
  const named = locatedToResolved(located, resolved, nodes).find(
    (node): node is SnapshotAddressableNode => isAddressable(node) && isTextField(node, platform),
  );
  if (named) {
    return named.enabled === false
      ? { kind: 'disabled-field', node: named }
      : { kind: 'target', node: named };
  }
  const fields = collectOutermostTextFields(resolved, nodes, platform);
  const enabled = fields.filter((field) => field.enabled !== false);
  if (enabled.length > 1) return { kind: 'several-fields', fields: enabled };
  if (enabled[0]) return { kind: 'target', node: enabled[0] };
  return fields[0]
    ? { kind: 'disabled-field', node: fields[0] }
    : { kind: 'target', node: resolved };
}

/** Promotion climbs to an ancestor or settles on a same-rect descendant, so only a climb has a path. */
function locatedToResolved(
  located: SnapshotNode,
  resolved: SnapshotNode,
  nodes: readonly SnapshotNode[],
): SnapshotNode[] {
  const byIndex = new Map(nodes.map((entry) => [entry.index, entry]));
  if (!isDescendantOf(located, resolved, byIndex)) return [located, resolved];
  const path = [located];
  let current = parentOf(located, byIndex);
  while (current && current.index !== resolved.index) {
    path.push(current);
    current = parentOf(current, byIndex);
  }
  return [...path, resolved];
}

function parentOf(
  node: SnapshotNode,
  byIndex: ReadonlyMap<number, SnapshotNode>,
): SnapshotNode | undefined {
  return typeof node.parentIndex === 'number' ? byIndex.get(node.parentIndex) : undefined;
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
      hasUsableRect(candidate) &&
      visibility.isVisibleOnScreen(candidate),
  );
  return fields.filter((field) => !fields.some((other) => isDescendantOf(field, other, byIndex)));
}

/** Visibility reads a node without bounds as visible, but a touch point could not aim at it. */
function hasUsableRect(node: SnapshotNode): boolean {
  const rect = normalizeRect(node.rect);
  return rect !== null && rect.width > 0 && rect.height > 0;
}

function isAddressable(node: SnapshotNode): node is SnapshotAddressableNode {
  return node.ref !== undefined;
}

/** An untyped node is lenient for a fill guard, but here being a field would make it the target. */
function isTextField(node: SnapshotNode, platform: Platform): boolean {
  return (
    node.editable ??
    (node.password === true ||
      (Boolean(node.type?.trim()) && isFillableType(node.type ?? '', platform)))
  );
}

/**
 * The scroll container a target with no usable frame may be scrolled out of (#4451): the nearest
 * scrollable sibling listed before it. That is the shape Flutter publishes on iOS: its
 * accessibility container lists a scroll view and then that scroll view's content, and keeps the
 * scrolled-out content with a zero-area frame. A target under a framed scroll ancestor never
 * reaches here, because the off-screen stage refuses it first.
 */
function findPrecedingScrollContainer(
  node: SnapshotNode,
  nodes: SnapshotState['nodes'],
): SnapshotNode | null {
  return (
    nodes
      .filter(
        (candidate) =>
          candidate.parentIndex === node.parentIndex &&
          candidate.index < node.index &&
          hasUsableRect(candidate) &&
          isScrollableNodeLike(candidate) &&
          !isScrollIndicator(candidate),
      )
      .at(-1) ?? null
  );
}

/** A scroll bar's kind also says "scroll", and it is not what the target scrolled out of. */
function isScrollIndicator(node: SnapshotNode): boolean {
  const kind = `${node.type ?? ''} ${node.role ?? ''} ${node.subrole ?? ''}`.toLowerCase();
  return /scroll\s?(bar|indicator)/.test(kind);
}

/**
 * The recovery for a target with no usable frame beside a scroll container. The frame that
 * refuses the touch point is also the one that would have named the direction, so the hint names
 * the command and leaves the direction open; the off-screen stage owns the directed form.
 */
function scrollContainerRecovery(
  node: SnapshotNode,
  nodes: SnapshotState['nodes'],
  shellQuotedSelector: string | undefined,
): { scrollContainerRef?: string; hint?: string } {
  if (hasUsableRect(node)) return {};
  const container = findPrecedingScrollContainer(node, nodes);
  if (!container) return {};
  const recovery = shellQuotedSelector
    ? `run scroll <direction> --until ${shellQuotedSelector} to bring it on screen, then retry with the same selector.`
    : 'scroll toward it, then retry with a selector (e.g. text=/id=) rather than an @ref — the scroll expires the ref frame, so re-run snapshot -i before reusing any @ref.';
  return {
    ...(container.ref ? { scrollContainerRef: container.ref } : {}),
    hint: `The target reports no frame, so nothing confirms it is on screen, and the frame names no direction. It may be scrolled out of a scrollable container: ${recovery}`,
  };
}

export function resolveNodeTouchPoint(
  node: SnapshotNode,
  nodes: SnapshotState['nodes'],
  failure: { invalidMessage: string; blockedTargetLabel: string } & (
    | { blockedTargetDetails: { ref: string } }
    /**
     * The recovery names a command that takes the selector, so the caller hands it over as one
     * shell word: this entry's eager closure stops short of the kernel's `shellQuote`.
     */
    | { blockedTargetDetails: { selector: string }; shellQuotedSelector: string }
  ),
): Point {
  const visibility = createSnapshotVisibility(nodes);
  const effectiveViewport = visibility.resolveEffectiveViewport(node);
  const rootViewport = node.rect ? visibility.resolveViewport(node.rect) : null;
  const resolution = resolveInteractionTouchPoint(nodes, node, {
    parentOwnedBounds: [effectiveViewport, rootViewport].filter((rect) => rect !== null),
  });
  if (resolution.kind === 'resolved') return resolution.point;
  if (resolution.kind === 'invalid') {
    throw discloseDispatch(
      new AppError('COMMAND_FAILED', failure.invalidMessage, {
        reason: INTERACTION_ERROR_REASONS.targetBoundsInvalid,
        ...bareTargetDetails(failure.blockedTargetDetails),
        ...scrollContainerRecovery(
          node,
          nodes,
          'shellQuotedSelector' in failure ? failure.shellQuotedSelector : undefined,
        ),
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
