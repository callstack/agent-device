import type { Rect, SnapshotNode } from '@agent-device/kernel/snapshot';
import {
  findNearestAncestor,
  findSnapshotAncestor,
  normalizeType,
  isViewportRootNode,
  resolveViewportRect,
} from '@agent-device/contracts/snapshot';
import { isSnapshotNodeInteractionBlocked } from '@agent-device/capture-kit/snapshot-occlusion';
import {
  areRectsApproximatelyEqual,
  normalizeRect,
  resolveRectCenter,
} from '@agent-device/kernel/rect-center';
import { intersectArea } from '@agent-device/kernel/screenshot-geometry';
import { isSemanticTouchTarget } from './touch-semantics.ts';

type ActionableTouchResolutionReason =
  | 'same-rect-descendant'
  | 'semantic-target'
  | 'hittable-ancestor'
  | 'overly-broad-ancestor'
  | 'original'
  | 'covered';

type ActionableTouchResolution = {
  node: SnapshotNode;
  reason: ActionableTouchResolutionReason;
};

type ActionableTouchIndex = {
  nodesByIndex: ReadonlyMap<number, SnapshotNode>;
  childrenByParentIndex: ReadonlyMap<number, readonly SnapshotNode[]>;
  viewportRootRects: readonly Rect[];
};

type ActionableTouchCandidateClassification =
  | { kind: 'equivalent'; node: SnapshotNode }
  | { kind: 'ambiguous'; candidates: SnapshotNode[] };

export function classifyActionableTouchCandidates(
  nodes: SnapshotNode[],
  candidates: SnapshotNode[],
): ActionableTouchCandidateClassification {
  const first = candidates[0];
  if (!first) return { kind: 'ambiguous', candidates };
  const index = buildActionableTouchIndex(nodes);
  if (!candidatesFormSingleAncestryChain(candidates, index.nodesByIndex)) {
    return { kind: 'ambiguous', candidates };
  }
  const actionable = resolveActionableTouchResolutionWithIndex(nodes, first, index).node;
  for (const candidate of candidates.slice(1)) {
    if (
      resolveActionableTouchResolutionWithIndex(nodes, candidate, index).node.index !==
      actionable.index
    ) {
      const wrapperControl = resolveUnverifiedWrapperControlWithIndex(candidates, index);
      return wrapperControl
        ? { kind: 'equivalent', node: wrapperControl }
        : { kind: 'ambiguous', candidates };
    }
  }
  return { kind: 'equivalent', node: actionable };
}

function candidatesFormSingleAncestryChain(
  candidates: readonly SnapshotNode[],
  byIndex: ReadonlyMap<number, SnapshotNode>,
): boolean {
  for (let i = 0; i < candidates.length; i += 1) {
    for (let j = i + 1; j < candidates.length; j += 1) {
      const left = candidates[i]!;
      const right = candidates[j]!;
      if (!isAncestorOf(left, right, byIndex) && !isAncestorOf(right, left, byIndex)) return false;
    }
  }
  return true;
}

function isAncestorOf(
  candidateAncestor: SnapshotNode,
  candidateDescendant: SnapshotNode,
  byIndex: ReadonlyMap<number, SnapshotNode>,
): boolean {
  let current = candidateDescendant;
  const visited = new Set<number>();
  while (current.parentIndex !== undefined && !visited.has(current.index)) {
    visited.add(current.index);
    if (current.parentIndex === candidateAncestor.index) return true;
    const parent = byIndex.get(current.parentIndex);
    if (!parent) return false;
    current = parent;
  }
  return false;
}

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
 * ladder: `press` sees two actionable elements and a uniqueness read (`is
 * visible`, `get attrs`) sees two matches for one toolbar button. The collapse
 * stays narrow on purpose: every candidate above the control must be a
 * non-actionable wrapper, so a chain of two real controls (a cell and the button
 * inside it) keeps the existing ambiguity refusal instead of silently resolving
 * to the descendant. Candidates carrying any hittability fact, and candidates
 * that do not form one ancestry chain, also keep the existing rules.
 */
function resolveUnverifiedWrapperControlWithIndex(
  candidates: readonly SnapshotNode[],
  index: ActionableTouchIndex,
): SnapshotNode | null {
  if (candidates.length < 2) return null;
  if (!candidatesFormSingleAncestryChain(candidates, index.nodesByIndex)) return null;
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

/**
 * The mirror half of the RN pair is not a view the app authored: it is the
 * synthetic element the platform reports for the reporter's accessibility
 * subtree, and it carries that reportage in its role/subrole
 * (`RCTAccessibilityElement` / `UIAccessibilityElement`, measured live via
 * `snapshot --raw`). Requiring it on every non-reporter candidate is what
 * distinguishes "one element the platform reported twice" from "two authored
 * elements that happen to share a label and a frame" — geometry cannot tell
 * those apart, only the reportage can. An authored child (a nested `<Text>`
 * styled to the same label at the same place, a `<View>` carrying the same
 * accessibilityLabel) has view-backed role/subrole and keeps the refusal.
 */
function isReportedAccessibilityElement(node: SnapshotNode): boolean {
  const roles = [node.type, node.role, node.subrole].map((value) => normalizeType(value ?? ''));
  return roles.some((role) => role.includes('accessibilityelement'));
}

/**
 * The React Native text shape, captured live from the fixture Catalog screen: a
 * `RCTParagraphComponentView` reporting the accessibility label (and the app's
 * `testID`) with its own `RCTAccessibilityElement` child repeating the identical
 * label at the identical rect. React Native exposes one authored `<Text>` this way,
 * so every label selector on RN text answers twice and the uniqueness rows would
 * refuse a line of text that is plainly on screen.
 *
 * The pair denotes one element, and the surviving one is the OUTER reporter: it
 * carries the identifier the app authored, it is the node the first-match rows
 * already answer with, and it is the node the interactive snapshot publishes —
 * `collectIosRepeatedStaticSuppression` keeps the outer reporter and suppresses the
 * mirror, which is why `snapshot -i` has always listed that line once while a
 * regular capture listed it twice. After the collapse, a read names the row an
 * interactive snapshot showed.
 *
 * Narrowest rule, and every clause is evidence rather than convenience:
 * - one ancestry chain — matches in distinct subtrees stay ambiguous;
 * - identical non-empty labels and rects agreeing within wrapper slack — a nested
 *   `<Text>` that repeats a word at its own position is a second run of text, not
 *   a mirror, and a distinct rect proves it;
 * - every non-reporter candidate is a reported accessibility element (above) —
 *   same label AND same frame is exactly the case where geometry cannot
 *   distinguish a mirror from a second authored element, so the reportage is
 *   required and an authored same-frame child stays ambiguous;
 * - no candidate is a semantic touch target — a button labelled like its own static
 *   text is two roles the caller still has to choose between (that shape is the
 *   wrapper rule above's job, through the hittability door it keeps);
 * - unlike the wrapper rule, candidates MAY carry hittability facts: the platform
 * *does* report them for this pair, which is exactly why the wrapper rule declines
 *   it and this one exists.
 */
function resolveTextEchoReporterWithIndex(
  candidates: readonly SnapshotNode[],
  index: ActionableTouchIndex,
): SnapshotNode | null {
  if (candidates.length < 2) return null;
  if (!candidatesFormSingleAncestryChain(candidates, index.nodesByIndex)) return null;
  if (candidates.some((candidate) => isSemanticTouchTarget(candidate))) return null;
  const reporter = candidates.reduce((outermost, candidate) =>
    (candidate.depth ?? 0) < (outermost.depth ?? 0) ? candidate : outermost,
  );
  const reporterLabel = reporter.label?.trim();
  if (!reporterLabel) return null;
  const reporterRect = normalizeRect(reporter.rect);
  if (!reporterRect) return null;
  const mirrorsOneReporter = candidates.every(
    (candidate) =>
      (candidate === reporter || isReportedAccessibilityElement(candidate)) &&
      candidate.label?.trim() === reporterLabel &&
      agreesWithinWrapperSlack(normalizeRect(candidate.rect), reporterRect),
  );
  return mirrorsOneReporter ? reporter : null;
}

/**
 * The structural rules that recognize a refused candidate set as ONE element the
 * platform reported twice, and name the node it should resolve to: a control under
 * its own accessibility wrapper, or an authored text reporter and its accessibility
 * mirror. Both the read door and the replay verification gate consume this, so a
 * screen cannot resolve one way live and another way under replay.
 */
export function resolveElementReportedTwice(
  nodes: SnapshotNode[],
  candidates: readonly SnapshotNode[],
): SnapshotNode | null {
  const index = buildActionableTouchIndex(nodes);
  return (
    resolveUnverifiedWrapperControlWithIndex(candidates, index) ??
    resolveTextEchoReporterWithIndex(candidates, index)
  );
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

export function isRootInteractionContainer(
  node: SnapshotNode,
  root: SnapshotNode | undefined,
): boolean {
  if (!root?.rect || !node.rect) return false;
  if (!isViewportRootNode(node)) return false;
  const left = node.rect;
  const right = root.rect;
  return (
    left.x === right.x &&
    left.y === right.y &&
    left.width === right.width &&
    left.height === right.height
  );
}

export function resolveActionableTouchResolution(
  nodes: SnapshotNode[],
  node: SnapshotNode,
): ActionableTouchResolution {
  return resolveActionableTouchResolutionWithIndex(nodes, node);
}

/** Resolves many candidates against one snapshot without rebuilding its indexes. */
export function createActionableTouchResolver(
  nodes: SnapshotNode[],
): (node: SnapshotNode) => ActionableTouchResolution {
  const index = buildActionableTouchIndex(nodes);
  return (node) => resolveActionableTouchResolutionWithIndex(nodes, node, index);
}

function resolveActionableTouchResolutionWithIndex(
  nodes: SnapshotNode[],
  node: SnapshotNode,
  index?: ActionableTouchIndex,
): ActionableTouchResolution {
  if (isSnapshotNodeInteractionBlocked(node)) {
    return { node, reason: 'covered' };
  }
  return (
    resolvePreferredDescendant(nodes, node, index) ??
    resolveSemanticTarget(node) ??
    resolveHittableAncestor(nodes, node, index) ?? { node, reason: 'original' }
  );
}

function resolvePreferredDescendant(
  nodes: SnapshotNode[],
  node: SnapshotNode,
  index: ActionableTouchIndex | undefined,
): ActionableTouchResolution | null {
  const descendant = findPreferredActionableDescendant(nodes, node, index);
  return descendant?.rect && resolveRectCenter(descendant.rect)
    ? { node: descendant, reason: 'same-rect-descendant' }
    : null;
}

function resolveSemanticTarget(node: SnapshotNode): ActionableTouchResolution | null {
  return isSemanticTouchTarget(node) && node.rect && resolveRectCenter(node.rect)
    ? { node, reason: 'semantic-target' }
    : null;
}

function resolveHittableAncestor(
  nodes: SnapshotNode[],
  node: SnapshotNode,
  index: ActionableTouchIndex | undefined,
): ActionableTouchResolution | null {
  const ancestor = findNearestHittableAncestor(nodes, node, index);
  if (!ancestor?.rect || isSnapshotNodeInteractionBlocked(ancestor)) return null;
  if (!resolveRectCenter(ancestor.rect)) return null;
  if (isOverlyBroadAncestor(node, ancestor, nodes, index)) {
    return { node, reason: 'overly-broad-ancestor' };
  }
  return { node: ancestor, reason: 'hittable-ancestor' };
}

function findNearestHittableAncestor(
  nodes: SnapshotNode[],
  node: SnapshotNode,
  index: ActionableTouchIndex | undefined,
): SnapshotNode | null {
  if (node.hittable) return node;
  const isHittable = (parent: SnapshotNode) => parent.hittable === true;
  if (!index) return findNearestAncestor(nodes, node, isHittable);
  return findSnapshotAncestor(nodes, node, index.nodesByIndex, (parent) =>
    isHittable(parent) ? parent : null,
  );
}

function findPreferredActionableDescendant(
  nodes: SnapshotNode[],
  node: SnapshotNode,
  index: ActionableTouchIndex | undefined,
): SnapshotNode | null {
  const targetRect = normalizeRect(node.rect);
  if (!targetRect) return null;

  let current = node;
  const visited = new Set<string>();
  while (!visited.has(current.ref)) {
    visited.add(current.ref);
    const children = index
      ? (index.childrenByParentIndex.get(current.index) ?? [])
      : nodes.filter((candidate) => candidate.parentIndex === current.index);
    const sameRectChildren = children.filter((candidate) => {
      if (!candidate.hittable || isSnapshotNodeInteractionBlocked(candidate)) return false;
      const candidateRect = normalizeRect(candidate.rect);
      return candidateRect ? areRectsApproximatelyEqual(candidateRect, targetRect) : false;
    });
    if (sameRectChildren.length !== 1) {
      break;
    }
    current = sameRectChildren[0]!;
  }

  return current === node ? null : current;
}

function isOverlyBroadAncestor(
  node: SnapshotNode,
  ancestor: SnapshotNode,
  nodes: SnapshotNode[],
  index: ActionableTouchIndex | undefined,
): boolean {
  const nodeRect = normalizeRect(node.rect);
  const ancestorRect = normalizeRect(ancestor.rect);
  if (!nodeRect || !ancestorRect) return false;
  if (isScrollingContainer(ancestor) && !areRectsApproximatelyEqual(nodeRect, ancestorRect)) {
    return true;
  }
  const rootViewportRect = resolveViewportRect(nodes, nodeRect, index?.viewportRootRects);
  if (!rootViewportRect) return false;
  if (!isRectViewportSized(ancestorRect, rootViewportRect)) return false;
  return !areRectsApproximatelyEqual(nodeRect, ancestorRect);
}

function isScrollingContainer(node: SnapshotNode): boolean {
  const type = normalizeType(node.type ?? '');
  return (
    type.includes('scrollview') ||
    type.includes('scrollarea') ||
    type.includes('listview') ||
    type.includes('recyclerview') ||
    type.includes('collectionview') ||
    type === 'list' ||
    type === 'table' ||
    type === 'collection'
  );
}

function buildActionableTouchIndex(nodes: readonly SnapshotNode[]): ActionableTouchIndex {
  const nodesByIndex = new Map<number, SnapshotNode>();
  const childrenByParentIndex = new Map<number, SnapshotNode[]>();
  const viewportRootRects: Rect[] = [];
  for (const node of nodes) {
    nodesByIndex.set(node.index, node);
    if (typeof node.parentIndex === 'number') {
      const children = childrenByParentIndex.get(node.parentIndex);
      if (children) children.push(node);
      else childrenByParentIndex.set(node.parentIndex, [node]);
    }
    if (isViewportRootNode(node)) {
      const rect = normalizeRect(node.rect);
      if (rect) viewportRootRects.push(rect);
    }
  }
  return { nodesByIndex, childrenByParentIndex, viewportRootRects };
}

function isRectViewportSized(rect: Rect, viewportRect: Rect): boolean {
  const overlapArea = intersectArea(rect, viewportRect);
  const rectArea = rect.width * rect.height;
  const viewportArea = viewportRect.width * viewportRect.height;
  if (overlapArea <= 0 || rectArea <= 0 || viewportArea <= 0) return false;

  const viewportCoverage = overlapArea / viewportArea;
  const rectCoverage = overlapArea / rectArea;
  return viewportCoverage >= 0.9 && rectCoverage >= 0.8;
}
