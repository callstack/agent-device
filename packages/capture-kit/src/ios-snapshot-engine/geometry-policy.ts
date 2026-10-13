import type { PresentedSurface, Rect, RawSnapshotNode } from '@agent-device/kernel/snapshot';
import { isPositiveFiniteRect, rectContains } from '@agent-device/kernel/rect';
import { normalizeType } from '@agent-device/contracts/snapshot';
import { collectChildrenByParent, collectSubtreeByParentLinks } from './tree.ts';
import type { IosSnapshotFoldPolicy } from './types.ts';

const SCROLL_CONTAINER_TYPES = new Set(['collectionview', 'scrollview', 'table']);
const VISIBILITY_CARRIER_TYPES = new Set(['application', 'window']);
const NEGLIGIBLE_DECORATION_TOLERANCE = 1;

/**
 * The container UIKit appends per presentation, and the one it presents app content inside. This is the
 * one place the name is written: the occlusion cut reads a LATER sibling of this class carrying a dimming
 * view as the presentation that dims everything before it, and the presented-surface rule reads a window
 * holding MORE than one of them as a capture it cannot call un-presented. A UIKit version that stopped
 * using this class would degrade one reader to `unknown` and the other to no cut at all, and both
 * failures are silent, so the pairing lives in the golden table's vocabulary and in both parity tests.
 */
export const PRESENTATION_CONTAINER_CLASS = 'UITransitionView';

/**
 * The dimming view a presentation dims the content behind it with. Only a presentation installs one. The
 * occlusion cut reads this node's `userInteractionEnabled` to decide what the user can still reach; the
 * presented-surface rule deliberately does not, because a sheet resting at an undimmed detent keeps a
 * dimming view that takes no touches and is still presented.
 */
export const PRESENTATION_DIMMING_VIEW_CLASS = 'UIDimmingView';

/**
 * The private root classes of a UIAlertController. An iPhone alert arrives in its own window with no
 * dimming view anywhere in the capture, so these classes are the only evidence that screen holds.
 */
export const ALERT_ROOT_CLASS_PREFIX = '_UIAlertController';

/**
 * Windows UIKit hosts outside the app's own scene. They can carry none of the app's presentations, so
 * neither the window nor anything under its subtree counts as evidence in either direction: a capture
 * taken with the keyboard up still reads as one content window.
 *
 * This is a denylist of the hosts iOS is known to name, not a way to recognize app content. The direction
 * is deliberate: an app that hosts its scene in a `UIWindow` subclass stays readable, while an allowlist
 * would answer `unknown` for every screen it did not recognize. The cost is that an unlisted host which
 * carries a dimming view of its own would read as `presented`; no such host has been observed.
 */
export const SYSTEM_WINDOW_CLASSES: ReadonlySet<string> = new Set([
  'UITextEffectsWindow',
  'UIRemoteKeyboardWindow',
]);

/**
 * Element types that name a presentation wherever they appear, keyed by the shared element-type
 * numbering every iOS producer reads. A producer whose own name table stops short of the name publishes
 * `Element(<number>)` for the same node, so both spellings count; the raw-value spelling is derived from
 * these numbers rather than listed beside them (#3565).
 *
 * The numbers belong to `ELEMENT_TYPE_NAMES` in `packages/platform-apple/src/snapshot-source/tree.ts`,
 * which is the table that turns an accessibility raw value into one of these names, and nothing imports
 * across that boundary — capture-kit sits below platform-apple. The golden table's vocabulary is the tie
 * that keeps the two in agreement: its parity test is read both by that package's own test, which
 * re-derives each name's index from the owner's table, and by both classifier parity tests.
 */
export const PRESENTING_ELEMENT_TYPES: ReadonlyMap<string, number> = new Map([
  ['Sheet', 5],
  ['Drawer', 6],
  ['Alert', 7],
  ['Dialog', 8],
]);

export type TraversalState = Readonly<{
  projectedOut: boolean;
  ancestorClip?: Rect;
}>;

export type BranchState = Readonly<{
  traversal: TraversalState;
  anchor?: { index: number; rect: Rect };
  keptIndex?: number;
  keptDepth: number;
}>;

export type GeometryDecision = Readonly<{
  isIncluded: boolean;
  descendants: TraversalState;
  effectiveRect?: Rect;
  hiddenContentFrame?: Rect;
  establishesScrollAnchor: boolean;
}>;

export function rootTraversal(): TraversalState {
  return { projectedOut: false };
}

export function traversalDecision(
  node: RawSnapshotNode,
  parentTraversal: TraversalState,
  viewport: Rect,
  interactiveOnly: boolean,
  hasChildren: boolean,
  policy: IosSnapshotFoldPolicy,
): GeometryDecision {
  const ancestorClip = policy === 'cursor-projected' ? parentTraversal.ancestorClip : undefined;
  const effectiveRect = effectiveSnapshotRect(node.rect, viewport, ancestorClip);
  const hasFrame = isPositiveFiniteRect(normalizeRect(node.rect));
  const intersectsClip = isPositiveFiniteRect(effectiveRect);
  const type = normalizeType(node.type ?? '');
  const projectedOut = descendantsProjectedOut(
    policy,
    parentTraversal.projectedOut,
    hasFrame,
    intersectsClip,
    type,
    hasChildren,
  );
  const visible =
    presentationVisible(policy, parentTraversal.projectedOut, hasFrame, intersectsClip) &&
    !isNegligibleDecoration(node, hasFrame, policy);
  const isIncluded = shouldInclude(node, visible, interactiveOnly, policy);
  const establishesScrollAnchor = ownsScrollAnchor(type, isIncluded, intersectsClip, hasChildren);
  const hiddenFrame = hiddenContentFrame(
    policy,
    parentTraversal.projectedOut,
    hasFrame,
    intersectsClip,
    node,
  );
  return {
    isIncluded,
    descendants: descendantTraversal(
      policy,
      projectedOut,
      ancestorClip,
      effectiveRect,
      establishesScrollAnchor,
    ),
    effectiveRect,
    ...(hiddenFrame ? { hiddenContentFrame: hiddenFrame } : {}),
    establishesScrollAnchor,
  };
}

function effectiveSnapshotRect(
  reportedRect: Rect | undefined,
  viewport: Rect,
  ancestorClip?: Rect,
): Rect | undefined {
  const normalized = normalizeRect(reportedRect);
  if (!normalized) return undefined;
  let effective = intersectRect(normalized, viewport);
  if (ancestorClip) effective = intersectRect(effective, ancestorClip);
  return effective;
}

function descendantsProjectedOut(
  policy: IosSnapshotFoldPolicy,
  parentProjectedOut: boolean,
  hasFrame: boolean,
  intersectsClip: boolean,
  type: string,
  hasChildren: boolean,
): boolean {
  if (policy === 'plain-viewport') return !intersectsClip;
  return parentProjectedOut || (hasFrame && !intersectsClip && ownsDescendants(type, hasChildren));
}

function presentationVisible(
  policy: IosSnapshotFoldPolicy,
  parentProjectedOut: boolean,
  hasFrame: boolean,
  intersectsClip: boolean,
): boolean {
  if (policy === 'plain-viewport') return intersectsClip;
  return !parentProjectedOut && (!hasFrame || intersectsClip);
}

function isNegligibleDecoration(
  node: RawSnapshotNode,
  hasFrame: boolean,
  policy: IosSnapshotFoldPolicy,
): boolean {
  if (
    policy !== 'cursor-projected' ||
    node.parentIndex === undefined ||
    hasSemanticContent(node) ||
    !hasFrame
  ) {
    return false;
  }
  return (
    normalizedRectWidth(node.rect) <= NEGLIGIBLE_DECORATION_TOLERANCE ||
    normalizedRectHeight(node.rect) <= NEGLIGIBLE_DECORATION_TOLERANCE
  );
}

function descendantTraversal(
  policy: IosSnapshotFoldPolicy,
  projectedOut: boolean,
  ancestorClip: Rect | undefined,
  effectiveRect: Rect | undefined,
  establishesScrollAnchor: boolean,
): TraversalState {
  return {
    projectedOut,
    ...(policy === 'cursor-projected' && establishesScrollAnchor
      ? { ancestorClip: effectiveRect }
      : { ancestorClip }),
  };
}

function hiddenContentFrame(
  policy: IosSnapshotFoldPolicy,
  parentProjectedOut: boolean,
  hasFrame: boolean,
  intersectsClip: boolean,
  node: RawSnapshotNode,
): Rect | undefined {
  if (policy !== 'cursor-projected' || parentProjectedOut || !hasFrame || intersectsClip) {
    return undefined;
  }
  return normalizeRect(node.rect);
}

function ownsDescendants(type: string, hasChildren: boolean): boolean {
  return hasChildren && (type === 'cell' || SCROLL_CONTAINER_TYPES.has(type));
}

function ownsScrollAnchor(
  type: string,
  isIncluded: boolean,
  intersectsClip: boolean,
  hasChildren: boolean,
): boolean {
  return isIncluded && intersectsClip && hasChildren && SCROLL_CONTAINER_TYPES.has(type);
}

function shouldInclude(
  node: RawSnapshotNode,
  visible: boolean,
  interactiveOnly: boolean,
  policy: IosSnapshotFoldPolicy,
): boolean {
  if (node.parentIndex === undefined) return true;
  const type = normalizeType(node.type ?? '');
  if (policy === 'plain-viewport' && interactiveOnly && !visible && type !== 'application') {
    return false;
  }
  return VISIBILITY_CARRIER_TYPES.has(type) || visible;
}

function hasSemanticContent(node: RawSnapshotNode): boolean {
  return [node.label, node.identifier, node.value].some(
    (value) => typeof value === 'string' && value.trim().length > 0,
  );
}

function normalizeRect(rect: Rect | undefined): Rect | undefined {
  if (!rect) return undefined;
  if (![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite)) return undefined;
  if (rect.width < 0 || rect.height < 0) return undefined;
  return { ...rect, width: Math.max(0, rect.width), height: Math.max(0, rect.height) };
}

function normalizedRectWidth(rect: Rect | undefined): number {
  return normalizeRect(rect)?.width ?? 0;
}

function normalizedRectHeight(rect: Rect | undefined): number {
  return normalizeRect(rect)?.height ?? 0;
}

function intersectRect(left: Rect, right: Rect): Rect {
  const x = Math.max(left.x, right.x);
  const y = Math.max(left.y, right.y);
  const rightEdge = Math.min(left.x + left.width, right.x + right.width);
  const bottomEdge = Math.min(left.y + left.height, right.y + right.height);
  if (rightEdge <= x || bottomEdge <= y) {
    return { x: left.x, y: left.y, width: 0, height: 0 };
  }
  return {
    x: rightEdge > x ? x : left.x,
    y: bottomEdge > y ? y : left.y,
    width: rightEdge - x,
    height: bottomEdge - y,
  };
}

type CoveringPresentation = Readonly<{
  container: RawSnapshotNode;
  dimmingRect: Rect;
}>;

/**
 * UIKit appends each modal presentation as a later sibling of the container it presents over,
 * dims the content behind it with a dimming view that is a direct child of the presentation
 * container, and the host accessibility snapshot reports siblings in that subview order. A
 * presenting container carries only a drop shadow, so a direct-child dimming view separates a
 * modal presentation from an ordinary container, and its dimmed area says which earlier
 * presentation the user can no longer reach. A sheet resting at an undimmed detent keeps that
 * dimming view with user interaction disabled and touches reach the content under it, so the
 * rule asserts containment only when the producer states the dimming view takes touches.
 *
 * Producers that report no UIKit class names or no `userInteractionEnabled` — the XCTest runner,
 * whose own queries already omit modal-contained content — never trigger this rule.
 */
export function collectModalContainedIndexes(
  nodes: readonly RawSnapshotNode[],
): ReadonlySet<number> {
  const childrenByParent = collectChildrenByParent(nodes);
  const contained = new Set<number>();
  for (const siblings of childrenByParent.values()) {
    const covering = findCoveringPresentation(siblings, childrenByParent);
    if (!covering) continue;
    for (const sibling of siblings.slice(0, -1)) {
      if (!isDimmedByPresentation(covering, sibling)) continue;
      contained.add(sibling.index);
      for (const descendant of collectSubtreeByParentLinks(sibling, childrenByParent)) {
        contained.add(descendant.index);
      }
    }
  }
  return contained;
}

function findCoveringPresentation(
  siblings: readonly RawSnapshotNode[],
  childrenByParent: ReadonlyMap<number, RawSnapshotNode[]>,
): CoveringPresentation | undefined {
  const last = siblings.at(-1);
  if (!last || !isPresentationContainer(last)) return undefined;
  const dimming = (childrenByParent.get(last.index) ?? []).find(isPresentationDimmingView);
  if (dimming?.userInteractionEnabled !== true || !isPositiveFiniteRect(dimming.rect)) {
    return undefined;
  }
  return { container: last, dimmingRect: dimming.rect };
}

function isDimmedByPresentation(covering: CoveringPresentation, sibling: RawSnapshotNode): boolean {
  return (
    isPresentationContainer(sibling) &&
    isPositiveFiniteRect(sibling.rect) &&
    rectContains(covering.dimmingRect, sibling.rect)
  );
}

function isPresentationContainer(node: RawSnapshotNode): boolean {
  return hasRole(node, PRESENTATION_CONTAINER_CLASS);
}

function isPresentationDimmingView(node: RawSnapshotNode): boolean {
  return hasRole(node, PRESENTATION_DIMMING_VIEW_CLASS);
}

/**
 * Roles are matched through `normalizeType`, which is what lets the occlusion cut and the
 * presented-surface rule agree on a class a producer spelled with a module prefix or in another case:
 * one predicate, so neither reader can drift to accepting a name the other refuses.
 */
function hasRole(node: RawSnapshotNode, role: string): boolean {
  return normalizeType(node.role ?? '') === normalizeType(role);
}

/**
 * What the capture's producer claims about its own completeness, stated by the caller from the
 * producer's truncation evidence instead of inferred from the tree: `complete` when the producer reports
 * it is not capped, `capped` when it reports a cap, `unstated` when it observes nothing either way.
 */
export type PresentedSurfaceCompleteness = 'complete' | 'capped' | 'unstated';

/**
 * Whether a capture read a modal presentation over the app's own content (#3565), decided on the
 * acquired tree so the interactive, full, depth-cut and scoped projections of one acquisition all
 * answer the same value. A raw `--depth` bounds the acquisition itself; one too shallow to reach the
 * presentation's windows answers `unknown`, never `absent`.
 *
 * UIKit appends each modal presentation as a later sibling of the container it presents over, directly
 * under the window, and dims what is behind it — the same shape `findCoveringPresentation` above rests
 * on when it drops dimmed content. That reader decides which nodes a user can still reach and so reads a
 * dimming view's enablement; this one decides only whether something is presented and must NOT read it: a
 * sheet resting at an undimmed detent keeps a dimming view that takes no touches and is still presented.
 *
 * `absent` is the strong answer and is never the default, because a consumer arms a dismissal
 * confirmation on it. It requires that the producer stated the capture was not capped, that every node
 * carries the UIKit class name this rule reads, that each node is numbered once so the parent links this
 * walk follows name the node they mean, and that the one content window under the app root holds exactly
 * one presentation container. Producers that report no class names — every XCTest runner tier — answer
 * `presented` or `unknown`, never `absent`.
 *
 * The cross-language rule and the tree shapes it is pinned on are the golden table
 * `contracts/fixtures/ios-presented-surface.json`; the Swift `SnapshotPresentedSurface` mirrors this
 * vocabulary and each side has a parity test against that table.
 */
export function collectPresentedSurface(
  nodes: readonly RawSnapshotNode[],
  completeness: PresentedSurfaceCompleteness,
): PresentedSurface {
  const windowPositions = appWindowPositions(nodes);
  const examinable = positionsOutsideSystemWindows(nodes, windowPositions);
  // Positive evidence is evidence of what the producer did read, so a cap does not defeat it; absence
  // is what a cap defeats, along with any capture that cannot state its own window structure.
  if (nodes.some((node, position) => examinable.has(position) && isPresentingEvidence(node))) {
    return 'presented';
  }
  if (completeness !== 'complete') return 'unknown';
  if (windowPositions.length === 0 || !nodes.every((node) => node.role !== undefined)) {
    return 'unknown';
  }
  // `absent` is a claim about every window the producer read, and window structure is read through
  // parent links, which cannot tell two nodes sharing a number apart. Positive evidence is already
  // reported above, keyed on the node it was read off rather than on its number, so the most a
  // collision can cost this rule is the answer it declines to make — never a false `absent`.
  if (!identifiesEachNodeOnce(nodes)) return 'unknown';

  const contentWindows = windowPositions.filter((position) => !isSystemWindow(nodes[position]!));
  if (contentWindows.length !== 1) return 'unknown';
  return presentationContainersIn(nodes[contentWindows[0]!]!, nodes).length === 1
    ? 'absent'
    : 'unknown';
}

/**
 * Positive evidence of a presentation: the dimming view a presentation owns, an alert's own root class,
 * or an element type that names a presentation. Each is a per-node fact, so a tree that holds one
 * answers without any window structure to read.
 */
function isPresentingEvidence(node: RawSnapshotNode): boolean {
  return isPresentationDimmingView(node) || isAlertRoot(node) || isPresentingElementType(node);
}

function isAlertRoot(node: RawSnapshotNode): boolean {
  const role = node.role;
  if (role === undefined) return false;
  const normalized = normalizeType(role);
  return normalized.startsWith(normalizeType(ALERT_ROOT_CLASS_PREFIX));
}

function isPresentingElementType(node: RawSnapshotNode): boolean {
  const type = node.type;
  if (!type) return false;
  if (PRESENTING_ELEMENT_TYPES.has(type)) return true;
  const reportedRawValue = UNNAMED_ELEMENT_TYPE.exec(type);
  return reportedRawValue !== null && PRESENTING_RAW_VALUES.has(Number(reportedRawValue[1]));
}

/** The name a producer publishes for an element type its own table does not cover. */
const UNNAMED_ELEMENT_TYPE = /^Element\((\d+)\)$/;

const PRESENTING_RAW_VALUES: ReadonlySet<number> = new Set(PRESENTING_ELEMENT_TYPES.values());

function isSystemWindow(node: RawSnapshotNode): boolean {
  const role = node.role;
  if (role === undefined) return false;
  const normalized = normalizeType(role);
  for (const systemWindowClass of SYSTEM_WINDOW_CLASSES) {
    if (normalizeType(systemWindowClass) === normalized) return true;
  }
  return false;
}

/**
 * Whether every node carries its own number, which is what lets a parent-link walk name the node it is
 * standing on. Positive evidence survives a repeated number — it is keyed on the node it was read off —
 * but window structure is read through those links, so a producer that numbered a node twice cannot
 * support a claim about every window it read, and such a tree is answered here rather than walked
 * further. The engine's own fold refuses this tree outright, so the regular route never reaches here with
 * one; the guard is what keeps the answer honest when the classifier is called on a tree that has not
 * passed through it — which is the Apple runner's route, where the classification runs on the acquisition
 * and no graph validation happens first. Both languages answer `unknown` for the same reason, which is
 * the parity the golden table pins.
 */
function identifiesEachNodeOnce(nodes: readonly RawSnapshotNode[]): boolean {
  return new Set(nodes.map((node) => node.index)).size === nodes.length;
}

/**
 * The app's windows: the nodes directly under its root, as the places in `nodes` they occupy. Both iOS
 * acquisition tiers report the app root and then one node per window, so finding them needs no class
 * facts — which is what lets a class-blind capture still be examined for the positive evidence it does
 * report.
 */
function appWindowPositions(nodes: readonly RawSnapshotNode[]): number[] {
  const rootPositions: number[] = [];
  for (const [position, node] of nodes.entries()) {
    if (node.parentIndex === undefined) rootPositions.push(position);
  }
  if (rootPositions.length !== 1) return [];
  const rootIndex = nodes[rootPositions[0]!]!.index;
  const windows: number[] = [];
  for (const [position, node] of nodes.entries()) {
    if (node.parentIndex === rootIndex) windows.push(position);
  }
  return windows;
}

/**
 * The nodes to read evidence from: every node except the ones the walk reached from a window UIKit hosts
 * outside the app's scene, keyed by the place in `nodes` each occupies rather than by its number. A walk
 * has to reach the node it is standing on, and two nodes sharing a number cannot be told apart by the
 * links that reach them; keying on the number would let a keyboard host's subtree swallow an app window's
 * own evidence, which is a direct read the rule would then throw away. Keying on the occurrence keeps that
 * read, and the numbering guard above is what stops such a tree from earning absence. A capture with no
 * class facts cannot single any window out, which is the honest reading: nothing in it is excludable, and
 * nothing in it can earn absence either.
 */
function positionsOutsideSystemWindows(
  nodes: readonly RawSnapshotNode[],
  windowPositions: readonly number[],
): ReadonlySet<number> {
  const positionsByParentIndex = new Map<number, number[]>();
  for (const [position, node] of nodes.entries()) {
    if (typeof node.parentIndex !== 'number') continue;
    const siblings = positionsByParentIndex.get(node.parentIndex) ?? [];
    siblings.push(position);
    positionsByParentIndex.set(node.parentIndex, siblings);
  }
  const examinable = new Set<number>(nodes.map((_node, position) => position));
  for (const windowPosition of windowPositions) {
    if (!isSystemWindow(nodes[windowPosition]!)) continue;
    for (const occurrence of subtreePositions(windowPosition, nodes, positionsByParentIndex)) {
      examinable.delete(occurrence);
    }
  }
  return examinable;
}

/**
 * A node and everything reachable from it through parent links, as the places in `nodes` they occupy.
 * Reported depths are not needed. Visited is keyed on the occurrence and seeded with the root: a producer
 * that closes a loop deeper in the tree is one this walk would follow forever, and the classification runs
 * outside the Apple runner's bounded main-thread work, where no timeout would catch the spin. The golden
 * table's cycle case is pinned on exactly that shape, in both languages.
 */
function subtreePositions(
  rootPosition: number,
  nodes: readonly RawSnapshotNode[],
  positionsByParentIndex: ReadonlyMap<number, readonly number[]>,
): number[] {
  const collected: number[] = [rootPosition];
  const visited = new Set<number>([rootPosition]);
  for (let walked = 0; walked < collected.length; walked += 1) {
    for (const position of positionsByParentIndex.get(nodes[collected[walked]!]!.index) ?? []) {
      if (visited.has(position)) continue;
      visited.add(position);
      collected.push(position);
    }
  }
  return collected;
}

function presentationContainersIn(
  window: RawSnapshotNode,
  nodes: readonly RawSnapshotNode[],
): RawSnapshotNode[] {
  return nodes.filter((node) => node.parentIndex === window.index && isPresentationContainer(node));
}
