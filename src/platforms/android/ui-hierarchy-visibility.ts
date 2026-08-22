import type { Rect } from '@agent-device/kernel/snapshot';
import type { AndroidSnapshotPresentationBudget } from './snapshot-presentation.ts';
import {
  hasMeaningfulLabel,
  hasPositiveRect,
  hasSemanticContent,
  isAgentTarget,
  isTouchTarget,
  type AndroidNode,
  type AndroidUiHierarchy,
} from './ui-hierarchy-node.ts';

/**
 * What the REGULAR projection hides: nodes Android marks invisible to users, stale application
 * windows, and same-window surfaces a higher drawing-order sibling covers (#1733/#1806).
 *
 * This is a classification, never a mutation. The parsed tree is shared by `--raw` (which must see
 * the acquired tree — C3), by the regular/interactive projections, and by hidden-content hint
 * derivation, which builds a second projection from the same tree; a pruner that edited
 * `node.children` in place made the tree depend on which projection ran first.
 */
export function collectAndroidHiddenNodes(
  root: AndroidUiHierarchy,
  presentationBudget?: AndroidSnapshotPresentationBudget,
): ReadonlySet<AndroidNode> {
  const hidden = new Set<AndroidNode>();
  collectInvisibleSubtrees(root, hidden, presentationBudget);
  collectInactiveApplicationWindows(root, hidden, presentationBudget);
  collectCoveredSubtrees(root, {
    footprintMemo: new WeakMap(),
    hidden,
    presentationBudget,
  });
  return hidden;
}

function collectInvisibleSubtrees(
  node: AndroidNode,
  hidden: Set<AndroidNode>,
  presentationBudget?: AndroidSnapshotPresentationBudget,
): void {
  for (const child of node.children) {
    presentationBudget?.check('work');
    if (child.visibleToUser === false) {
      hidden.add(child);
      continue;
    }
    collectInvisibleSubtrees(child, hidden, presentationBudget);
  }
}

/** The children of `node` this projection still shows, in document order. */
function retainedChildren(
  node: AndroidNode,
  hidden: ReadonlySet<AndroidNode>,
  presentationBudget?: AndroidSnapshotPresentationBudget,
): AndroidNode[] {
  presentationBudget?.check('work');
  return node.children.filter((child) => !hidden.has(child) && child.visibleToUser !== false);
}

type AndroidFootprint = {
  /** Boxes of what the subtree paints: touch targets, scrollables and labelled leaves. */
  paints: Rect[];
  /** Boxes of what an agent would see of the subtree: `paints` plus labelled/identified nodes. */
  shows: Rect[];
  hasAgentTarget: boolean;
};

type AndroidTreePruneState = {
  footprintMemo: WeakMap<AndroidNode, AndroidFootprint>;
  hidden: Set<AndroidNode>;
  presentationBudget?: AndroidSnapshotPresentationBudget;
};

type AndroidCoveringCandidate = {
  node: AndroidNode;
  drawingOrder: number;
  footprint: Rect[];
};

const ANDROID_WINDOW_TYPE_APPLICATION = 1;

/**
 * Focusability is traversal, not paint (#1733), and a label is an announcement, not paint (#1806):
 * a container's content-desc describes its children and an empty labelled View draws nothing. Only
 * a touch target is direct evidence that a node hides what lies under its box.
 */
function hasDirectOcclusionEvidence(node: AndroidNode): boolean {
  return node.visibleToUser !== false && isTouchTarget(node);
}

/** Evidence the node is a real surface because it contains something an agent could drive. */
function hasDescendantOcclusionEvidence(node: AndroidNode, state: AndroidTreePruneState): boolean {
  return retainedChildren(node, state.hidden, state.presentationBudget).some(
    (child) => subtreeFootprint(child, state).hasAgentTarget,
  );
}

/**
 * What a subtree paints and what it shows. Paint is the boxes of its touch-consuming surfaces
 * (touch targets, scrollables) and labelled leaves: a full-screen debug overlay
 * holding one floating icon paints only that icon, so it can only hide what sits under the icon,
 * never the whole app behind it (#1806). Rects are kept apart rather than merged into one bounding
 * box: two controls in opposite corners paint two corners, not the screen between them.
 *
 * Shows adds every labelled or identified node — a testID marker or a described container paints
 * nothing, so it never helps a candidate cover, but an agent would still lose it, so it always
 * counts toward what a covered sibling has.
 */
function subtreeFootprint(node: AndroidNode, state: AndroidTreePruneState): AndroidFootprint {
  state.presentationBudget?.check('work');
  const cached = state.footprintMemo.get(node);
  if (cached !== undefined) return cached;
  const footprint = hasPositiveRect(node)
    ? footprintWithinBox(node, node.rect, state)
    : childrenFootprint(node, state);
  state.footprintMemo.set(node, footprint);
  return footprint;
}

function footprintWithinBox(
  node: AndroidNode,
  ownBox: Rect,
  state: AndroidTreePruneState,
): AndroidFootprint {
  if (paintsOwnBox(node, state.hidden)) {
    // The whole box is painted; whatever it contains lies inside that box.
    return { paints: [ownBox], shows: [ownBox], hasAgentTarget: isAgentTarget(node) };
  }
  const footprint = childrenFootprint(node, state);
  if (hasSemanticContent(node)) footprint.shows.push(ownBox);
  return footprint;
}

function childrenFootprint(node: AndroidNode, state: AndroidTreePruneState): AndroidFootprint {
  const footprint: AndroidFootprint = {
    paints: [],
    shows: [],
    hasAgentTarget: isAgentTarget(node),
  };
  for (const child of retainedChildren(node, state.hidden, state.presentationBudget)) {
    const childFootprint = subtreeFootprint(child, state);
    footprint.hasAgentTarget ||= childFootprint.hasAgentTarget;
    footprint.paints.push(...childFootprint.paints);
    footprint.shows.push(...childFootprint.shows);
  }
  return footprint;
}

/** Focusability is traversal, not paint (#1733); a container's label describes its children. */
function paintsOwnBox(node: AndroidNode, hidden: ReadonlySet<AndroidNode>): boolean {
  return (
    isTouchTarget(node) ||
    node.scrollable === true ||
    (retainedChildren(node, hidden).length === 0 && hasMeaningfulLabel(node))
  );
}

/** Fraction of the covered rects' union that lies under the covering rects' union. */
function unionCoverage(
  coveringRects: Rect[],
  coveredRects: Rect[],
  presentationBudget?: AndroidSnapshotPresentationBudget,
): number {
  const xs = compressedEdges([...coveringRects, ...coveredRects], (rect) => [
    rect.x,
    rect.x + rect.width,
  ]);
  const ys = compressedEdges([...coveringRects, ...coveredRects], (rect) => [
    rect.y,
    rect.y + rect.height,
  ]);
  const xIndex = createEdgeIndex(xs, presentationBudget);
  const yIndex = createEdgeIndex(ys, presentationBudget);
  const covering = markCells(coveringRects, xIndex, yIndex, presentationBudget);
  const covered = markCells(coveredRects, xIndex, yIndex, presentationBudget);
  const rows = ys.length - 1;
  const columns = xs.length - 1;
  presentationBudget?.consume(columns * rows);
  let coveredArea = 0;
  let overlapArea = 0;
  for (let column = 0; column < columns; column += 1) {
    presentationBudget?.check('work');
    const width = xs[column + 1]! - xs[column]!;
    for (let row = 0; row < rows; row += 1) {
      const cell = column * rows + row;
      if (!covered[cell]) continue;
      const area = width * (ys[row + 1]! - ys[row]!);
      coveredArea += area;
      if (covering[cell]) overlapArea += area;
    }
  }
  return coveredArea <= 0 ? 0 : overlapArea / coveredArea;
}

function compressedEdges(rects: Rect[], edgesOf: (rect: Rect) => [number, number]): number[] {
  return [...new Set(rects.flatMap(edgesOf))].sort((left, right) => left - right);
}

function createEdgeIndex(
  edges: number[],
  presentationBudget?: AndroidSnapshotPresentationBudget,
): ReadonlyMap<number, number> {
  presentationBudget?.consume(edges.length);
  return new Map(edges.map((edge, index) => [edge, index]));
}

function markCells(
  rects: Rect[],
  xIndex: ReadonlyMap<number, number>,
  yIndex: ReadonlyMap<number, number>,
  presentationBudget?: AndroidSnapshotPresentationBudget,
): Uint8Array {
  const rows = yIndex.size - 1;
  const columns = xIndex.size - 1;
  const cellCount = columns * rows;
  presentationBudget?.consume(cellCount);
  const cells = new Uint8Array(cellCount);
  for (const rect of rects) {
    presentationBudget?.check('work');
    const firstColumn = xIndex.get(rect.x)!;
    const lastColumn = xIndex.get(rect.x + rect.width)!;
    const firstRow = yIndex.get(rect.y)!;
    const lastRow = yIndex.get(rect.y + rect.height)!;
    for (let column = firstColumn; column < lastColumn; column += 1) {
      presentationBudget?.check('work');
      presentationBudget?.consume(lastRow - firstRow);
      cells.fill(1, column * rows + firstRow, column * rows + lastRow);
    }
  }
  return cells;
}

/**
 * A childless sibling that only presents: an RN screen-level testID, or a label drawn inside a
 * higher sibling's box (Telegram's `+` over the country-code EditText). Geometry cannot tell a
 * transparent overlay from an opaque one, and exempting a leaf cannot resurrect a covered surface.
 */
function isPresentationLeaf(node: AndroidNode, hidden: ReadonlySet<AndroidNode>): boolean {
  return (
    retainedChildren(node, hidden).length === 0 && !isAgentTarget(node) && hasSemanticContent(node)
  );
}

function collectCoveredSubtrees(node: AndroidNode, state: AndroidTreePruneState): void {
  state.presentationBudget?.check('work');
  for (const child of retainedChildren(node, state.hidden, state.presentationBudget)) {
    collectCoveredSubtrees(child, state);
  }
  const siblings = retainedChildren(node, state.hidden, state.presentationBudget);
  if (siblings.length < 2) return;
  const coveringCandidates = siblings
    .map((sibling) => coveringCandidateOf(sibling, state))
    .filter((candidate) => candidate !== null);
  if (coveringCandidates.length === 0) return;
  for (const child of siblings) {
    if (!shouldKeepAndroidSibling(child, coveringCandidates, state)) state.hidden.add(child);
  }
}

function shouldKeepAndroidSibling(
  node: AndroidNode,
  coveringCandidates: AndroidCoveringCandidate[],
  state: AndroidTreePruneState,
): boolean {
  return (
    isPresentationLeaf(node, state.hidden) ||
    !isCoveredByHigherDrawingOrderSibling(node, coveringCandidates, state)
  );
}

/**
 * Covered means everything an agent would see of the sibling lies under what the candidate paints,
 * by actual overlapped area. Comparing footprints rather than boxes lets two stacked screens with the
 * same layout margins still register as covered, while a sparse overlay never condemns a rich
 * screen however far apart its controls sit.
 */
function isCoveredByHigherDrawingOrderSibling(
  node: AndroidNode,
  coveringCandidates: AndroidCoveringCandidate[],
  state: AndroidTreePruneState,
): boolean {
  if (node.visibleToUser === false || node.drawingOrder === undefined || !hasPositiveRect(node)) {
    return false;
  }
  const shows = subtreeFootprint(node, state).shows;
  const coveredRects = shows.length > 0 ? shows : [node.rect];
  for (const candidate of coveringCandidates) {
    state.presentationBudget?.check('work');
    if (candidate.node === node || candidate.drawingOrder <= node.drawingOrder) {
      continue;
    }
    if (unionCoverage(candidate.footprint, coveredRects, state.presentationBudget) >= 0.9) {
      return true;
    }
  }
  return false;
}

/** The single occlusion classification. Covering is never re-derived from a raw attribute. */
function coveringCandidateOf(
  node: AndroidNode,
  state: AndroidTreePruneState,
): AndroidCoveringCandidate | null {
  const { drawingOrder } = node;
  if (node.visibleToUser === false || drawingOrder === undefined || !hasPositiveRect(node)) {
    return null;
  }
  if (!hasDirectOcclusionEvidence(node) && !hasDescendantOcclusionEvidence(node, state)) {
    return null;
  }
  const footprint = subtreeFootprint(node, state).paints;
  return footprint.length > 0 ? { node, drawingOrder, footprint } : null;
}

function collectInactiveApplicationWindows(
  root: AndroidUiHierarchy,
  hidden: Set<AndroidNode>,
  presentationBudget?: AndroidSnapshotPresentationBudget,
): void {
  const windows = retainedChildren(root, hidden, presentationBudget).filter(isAndroidWindowRoot);
  if (windows.length < 2) return;

  // Android can keep stale application windows in the accessibility tree after drawer and
  // navigation transitions. Keep dialogs/system windows, but expose only the foreground
  // application layer so agents do not act on content that is hidden from users.
  const foregroundApplicationWindows = windows.filter(
    (window) => isAndroidApplicationWindow(window) && isAndroidForegroundWindow(window),
  );
  if (foregroundApplicationWindows.length === 0) return;
  const foregroundLayer = highestAndroidWindowLayer(foregroundApplicationWindows);

  for (const window of retainedChildren(root, hidden, presentationBudget)) {
    presentationBudget?.check('work');
    if (!isAndroidApplicationWindow(window)) continue;
    const keep =
      isAndroidForegroundWindow(window) &&
      (foregroundLayer === undefined || window.windowLayer === foregroundLayer);
    if (!keep) hidden.add(window);
  }
}

function highestAndroidWindowLayer(windows: AndroidNode[]): number | undefined {
  const layers = windows
    .map((window) => window.windowLayer)
    .filter((layer): layer is number => layer !== undefined);
  return layers.length > 0 ? Math.max(...layers) : undefined;
}

function isAndroidWindowRoot(node: AndroidNode): boolean {
  return node.windowIndex !== undefined || node.windowType !== undefined;
}

function isAndroidApplicationWindow(node: AndroidNode): boolean {
  return node.windowType === ANDROID_WINDOW_TYPE_APPLICATION;
}

function isAndroidForegroundWindow(node: AndroidNode): boolean {
  return node.windowActive === true || node.windowFocused === true;
}
