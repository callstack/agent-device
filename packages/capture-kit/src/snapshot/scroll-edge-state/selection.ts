import { deriveMobileSnapshotHiddenContentHints } from '../../mobile-snapshot-semantics.ts';
import {
  createSnapshotVisibility,
  isScrollableNodeLike,
  isViewportRootNode,
} from '@agent-device/contracts/snapshot';
import type {
  HiddenContentHint,
  Point,
  RawSnapshotNode,
  SnapshotNode,
} from '@agent-device/kernel/snapshot';
import type { ScrollEdge, ScrollEdgeState, ScrollEdgeTarget } from '../scroll-edge-state.ts';

export function analyzeScrollEdgeState(
  inputNodes: readonly (RawSnapshotNode | SnapshotNode)[],
  edge: ScrollEdge,
  target: ScrollEdgeTarget = {},
): ScrollEdgeState {
  const nodes = normalizeSnapshotNodes(inputNodes);
  if (nodes.length === 0) {
    return {
      canScroll: false,
      emptySnapshot: true,
    };
  }

  const hiddenHints = deriveMobileSnapshotHiddenContentHints(nodes);
  const container = selectScrollContainer(nodes, hiddenHints, edge, target);
  if (!container) {
    return {
      canScroll: false,
      emptySnapshot: false,
    };
  }

  const canScroll = hasHiddenContentAtEdge(container, hiddenHints.get(container.index), edge);
  return {
    canScroll,
    emptySnapshot: false,
    scope: buildScrollContainerScope(container, nodes),
    fingerprint: buildSurfaceFingerprint(container, nodes),
  };
}

function normalizeSnapshotNodes(
  nodes: readonly (RawSnapshotNode | SnapshotNode)[],
): SnapshotNode[] {
  return nodes.map((node, index) => ({
    ...node,
    ref: 'ref' in node && node.ref ? node.ref : `e${index + 1}`,
  }));
}

function selectScrollContainer(
  nodes: SnapshotNode[],
  hiddenHints: Map<number, HiddenContentHint>,
  edge: ScrollEdge,
  target: ScrollEdgeTarget,
): SnapshotNode | null {
  const visibility = createSnapshotVisibility(nodes);
  const scrollables = nodes.filter((node) => isScrollableNodeLike(node) && isUsableRect(node.rect));
  if (scrollables.length === 0) return null;

  const targetAncestor = findNearestScrollableAncestor(target.nodeIndex, visibility.nodeByIndex);
  if (targetAncestor) {
    return targetAncestor;
  }

  const targetPoint = target.point;
  if (targetPoint) {
    const containing = selectPointScrollContainer(scrollables, hiddenHints, edge, targetPoint);
    if (containing) return containing;
    return selectBroadScrollContainer(scrollables, hiddenHints, edge, visibility);
  }

  const viewportCenter = inferViewportCenter(nodes);
  if (viewportCenter) {
    const centered = selectPointScrollContainer(scrollables, hiddenHints, edge, viewportCenter);
    if (centered) return centered;
  }

  return selectBroadScrollContainer(scrollables, hiddenHints, edge, visibility);
}

function selectBroadScrollContainer(
  scrollables: SnapshotNode[],
  hiddenHints: Map<number, HiddenContentHint>,
  edge: ScrollEdge,
  visibility: ReturnType<typeof createSnapshotVisibility>,
): SnapshotNode | null {
  const withHiddenEdge = scrollables
    .filter((node) => hasHiddenContentAtEdge(node, hiddenHints.get(node.index), edge))
    .sort((a, b) => compareByArea(b, a));
  if (withHiddenEdge.length > 0) return withHiddenEdge[0] ?? null;

  const visibleScrollables = scrollables
    .filter(visibility.isVisibleInEffectiveViewport)
    .sort((a, b) => compareByArea(b, a));
  return visibleScrollables[0] ?? scrollables.sort((a, b) => compareByArea(b, a))[0] ?? null;
}

function selectPointScrollContainer(
  scrollables: SnapshotNode[],
  hiddenHints: Map<number, HiddenContentHint>,
  edge: ScrollEdge,
  point: Point,
): SnapshotNode | null {
  const containing = scrollables
    .filter((node) => node.rect && containsPoint(node.rect, point))
    .sort(compareByArea);
  const withHiddenEdge = containing.find((node) =>
    hasHiddenContentAtEdge(node, hiddenHints.get(node.index), edge),
  );
  return withHiddenEdge ?? containing[0] ?? null;
}

function inferViewportCenter(nodes: SnapshotNode[]): Point | undefined {
  const viewport = nodes
    .filter((node) => isViewportRootNode(node) && isUsableRect(node.rect))
    .sort((a, b) => compareByArea(b, a))[0]?.rect;
  if (!viewport) return undefined;
  return {
    x: viewport.x + viewport.width / 2,
    y: viewport.y + viewport.height / 2,
  };
}

function findNearestScrollableAncestor(
  nodeIndex: number | undefined,
  byIndex: ReadonlyMap<number, SnapshotNode>,
): SnapshotNode | null {
  if (nodeIndex === undefined) return null;
  let node = byIndex.get(nodeIndex);
  while (node) {
    if (isScrollableNodeLike(node) && isUsableRect(node.rect)) {
      return node;
    }
    node = node.parentIndex === undefined ? undefined : byIndex.get(node.parentIndex);
  }
  return null;
}

function hasHiddenContentAtEdge(
  node: SnapshotNode,
  hint: HiddenContentHint | undefined,
  edge: ScrollEdge,
): boolean {
  if (edge === 'bottom') {
    return node.hiddenContentBelow === true || hint?.hiddenContentBelow === true;
  }
  return node.hiddenContentAbove === true || hint?.hiddenContentAbove === true;
}

function buildScrollContainerScope(
  node: SnapshotNode,
  nodes: readonly SnapshotNode[],
): string | undefined {
  return [node.identifier, node.label]
    .filter((value): value is string => typeof value === 'string')
    .map((value) => value.trim())
    .find((value) => isUsefulScope(value) && isUniqueScopeValue(value, node, nodes));
}

function isUniqueScopeValue(
  value: string,
  target: SnapshotNode,
  nodes: readonly SnapshotNode[],
): boolean {
  const normalized = value.toLowerCase();
  const matches = nodes.filter((node) =>
    [node.identifier, node.label, node.value].some(
      (candidate) =>
        typeof candidate === 'string' && candidate.trim().toLowerCase().includes(normalized),
    ),
  );
  return matches.length === 1 && matches[0]?.index === target.index;
}

function isUsefulScope(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 80 &&
    !/^(true|false)$/i.test(value) &&
    !/^\d+$/.test(value) &&
    !/^\d+%$/.test(value)
  );
}

function compareByArea(a: SnapshotNode, b: SnapshotNode): number {
  return rectArea(a.rect) - rectArea(b.rect);
}

function rectArea(rect: SnapshotNode['rect']): number {
  return rect ? rect.width * rect.height : 0;
}

function containsPoint(rect: NonNullable<SnapshotNode['rect']>, point: Point): boolean {
  return (
    point.x >= rect.x &&
    point.x <= rect.x + rect.width &&
    point.y >= rect.y &&
    point.y <= rect.y + rect.height
  );
}

function isUsableRect(rect: SnapshotNode['rect']): rect is NonNullable<SnapshotNode['rect']> {
  return Boolean(rect && rect.width > 0 && rect.height > 0);
}

/**
 * A stable signature of the content the container currently shows, built from the container's own
 * descendants (via the parent chain), each keyed by its identity fields and rounded position.
 * Scrolling shifts descendant rects, and a recycled cell that keeps its slot while its text changes
 * re-keys, so a real pass always changes it; a gesture the container ignores leaves it byte-identical.
 * Descendant scoping — not geometric overlap — is the point: it excludes the keyboard, its typing
 * predictions, and scroll-indicator overlays, which are not under the scroller and would otherwise
 * flicker and mask a stuck container. Rounded to whole pixels so layout jitter never fakes movement;
 * a false "unchanged" only defers to a later pass or the pass limit. An empty string (a container with
 * no positioned descendants) leaves both loops to their edge/pass signals.
 */
function buildSurfaceFingerprint(container: SnapshotNode, nodes: SnapshotNode[]): string {
  const byIndex = new Map<number, SnapshotNode>();
  for (const node of nodes) byIndex.set(node.index, node);
  const descendants: string[] = [];
  for (const node of nodes) {
    const rect = node.rect;
    if (!isUsableRect(rect)) continue;
    if (node.index === container.index || !isDescendantOf(node, container.index, byIndex)) continue;
    descendants.push(
      `${node.type}#${surfaceIdentity(node)}@${Math.round(rect.x)},${Math.round(rect.y)}`,
    );
  }
  if (descendants.length === 0) return '';
  descendants.sort();
  return descendants.join(';');
}

function surfaceIdentity(node: SnapshotNode): string {
  // All three content fields, not first-present: a recycled cell keeps its identifier and slot while
  // its label/value change, and that text change is exactly the progress the signature must register.
  const identifier = (node.identifier ?? '').trim();
  const label = (node.label ?? '').trim();
  const value = (node.value ?? '').trim();
  return `${identifier} ${label} ${value}`;
}

function isDescendantOf(
  node: SnapshotNode,
  ancestorIndex: number,
  byIndex: ReadonlyMap<number, SnapshotNode>,
): boolean {
  let parentIndex = node.parentIndex;
  let guard = byIndex.size + 1;
  while (parentIndex !== undefined && guard-- > 0) {
    if (parentIndex === ancestorIndex) return true;
    parentIndex = byIndex.get(parentIndex)?.parentIndex;
  }
  return false;
}
