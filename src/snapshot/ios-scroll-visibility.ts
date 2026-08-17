import type { RawSnapshotNode, SnapshotCaptureBackend } from '@agent-device/kernel/snapshot';
import { isPositiveFiniteRect, isRectVisibleInViewport } from '@agent-device/kernel/rect';
import { isScrollableNodeLike } from '@agent-device/contracts/snapshot';

type HiddenDirection = 'above' | 'below';
type ProjectionBuildState = {
  byIndex: ReadonlyMap<number, RawSnapshotNode>;
  effectiveLeadingEdgeByScrollIndex: Map<number, { x: number; y: number }>;
  scrollByNodeIndex: Map<number, RawSnapshotNode>;
  hiddenDirections: Map<number, HiddenDirection>;
  hiddenIndexes: Set<number>;
  hintsByScrollIndex: Map<number, { above: boolean; below: boolean }>;
  resolvedIndexes: Set<number>;
};
type CollapsedClusterCollectionState = {
  activeAncestorMemo: Map<number, boolean>;
  activeCluster: RawSnapshotNode[];
  activeClusterIndexes: Set<number>;
  activeKey?: string;
  pendingEvidenceKey?: string;
};
const MIN_COLLAPSED_PRIVATE_AX_CLUSTER_SIZE = 4;
const PRIVATE_AX_EDGE_TOLERANCE_PX = 1;

export type IosScrollVisibilityProjection = {
  hiddenIndexes: Set<number>;
  hintsByScrollIndex: Map<number, { above: boolean; below: boolean }>;
  scrollByNodeIndex: Map<number, RawSnapshotNode>;
};

export function projectIosScrollVisibility(
  nodes: RawSnapshotNode[],
  captureBackend?: SnapshotCaptureBackend,
): IosScrollVisibilityProjection {
  const state: ProjectionBuildState = {
    byIndex: new Map(nodes.map((node) => [node.index, node])),
    effectiveLeadingEdgeByScrollIndex: new Map(),
    scrollByNodeIndex: new Map(),
    hiddenDirections: new Map(),
    hiddenIndexes: new Set(),
    hintsByScrollIndex: new Map(),
    resolvedIndexes: new Set(),
  };

  for (const node of nodes) {
    resolveBaseVisibility(node, state);
  }
  if (captureBackend === 'private-ax') {
    collectEffectiveLeadingScrollEdges(nodes, state);
    suppressCollapsedPrivateAxClusters(nodes, state);
  }

  return {
    hiddenIndexes: state.hiddenIndexes,
    hintsByScrollIndex: state.hintsByScrollIndex,
    scrollByNodeIndex: state.scrollByNodeIndex,
  };
}

function resolveBaseVisibility(node: RawSnapshotNode, state: ProjectionBuildState): void {
  if (state.resolvedIndexes.has(node.index)) return;
  const path = collectUnresolvedAncestry(node, state);
  for (let position = path.length - 1; position >= 0; position -= 1) {
    resolveCandidateVisibility(path[position]!, state);
  }
}

function collectUnresolvedAncestry(
  node: RawSnapshotNode,
  state: ProjectionBuildState,
): RawSnapshotNode[] {
  const path: RawSnapshotNode[] = [];
  const visited = new Set<number>();
  let current: RawSnapshotNode | undefined = node;
  while (current && !state.resolvedIndexes.has(current.index) && !visited.has(current.index)) {
    visited.add(current.index);
    path.push(current);
    current =
      typeof current.parentIndex === 'number' ? state.byIndex.get(current.parentIndex) : undefined;
  }
  return path;
}

function resolveCandidateVisibility(candidate: RawSnapshotNode, state: ProjectionBuildState): void {
  const parent =
    typeof candidate.parentIndex === 'number'
      ? state.byIndex.get(candidate.parentIndex)
      : undefined;
  const scrollAncestor = resolveScrollAncestor(parent, state.scrollByNodeIndex);
  state.resolvedIndexes.add(candidate.index);
  if (!scrollAncestor) return;
  state.scrollByNodeIndex.set(candidate.index, scrollAncestor);
  const hidden = classifyBaseHiddenNode(
    candidate,
    parent,
    scrollAncestor,
    state.hiddenIndexes,
    state.hiddenDirections,
  );
  if (hidden) rememberHiddenNode(candidate, scrollAncestor, hidden.direction, state);
}

function collectEffectiveLeadingScrollEdges(
  nodes: RawSnapshotNode[],
  state: ProjectionBuildState,
): void {
  for (const node of nodes) {
    const candidate = effectiveLeadingEdgeCandidate(node, state.byIndex);
    if (!candidate) continue;
    const { edge, scroll } = candidate;
    const current = state.effectiveLeadingEdgeByScrollIndex.get(scroll.index);
    if (!current || edge.y < current.y) {
      state.effectiveLeadingEdgeByScrollIndex.set(scroll.index, edge);
    }
  }
}

function effectiveLeadingEdgeCandidate(
  node: RawSnapshotNode,
  byIndex: ReadonlyMap<number, RawSnapshotNode>,
): { edge: { x: number; y: number }; scroll: RawSnapshotNode } | undefined {
  const scroll = directScrollableParent(node, byIndex);
  if (!scroll) return undefined;
  const rects = visibleRectPair(node, scroll);
  if (!rects) return undefined;
  return {
    scroll,
    edge: { x: rects.scroll.x, y: Math.max(rects.node.y, rects.scroll.y) },
  };
}

function directScrollableParent(
  node: RawSnapshotNode,
  byIndex: ReadonlyMap<number, RawSnapshotNode>,
): RawSnapshotNode | undefined {
  if (node.parentIndex === undefined || typeof node.depth !== 'number') return undefined;
  const parent = byIndex.get(node.parentIndex);
  return parent &&
    typeof parent.depth === 'number' &&
    node.depth === parent.depth + 1 &&
    isScrollableNodeLike(parent)
    ? parent
    : undefined;
}

function visibleRectPair(
  node: RawSnapshotNode,
  scroll: RawSnapshotNode,
):
  | {
      node: NonNullable<RawSnapshotNode['rect']>;
      scroll: NonNullable<RawSnapshotNode['rect']>;
    }
  | undefined {
  if (!isPositiveFiniteRect(node.rect) || !isPositiveFiniteRect(scroll.rect)) return undefined;
  return isRectVisibleInViewport(node.rect, scroll.rect)
    ? { node: node.rect, scroll: scroll.rect }
    : undefined;
}

function resolveScrollAncestor(
  parent: RawSnapshotNode | undefined,
  scrollByNodeIndex: ReadonlyMap<number, RawSnapshotNode>,
): RawSnapshotNode | undefined {
  if (!parent) return undefined;
  return isScrollableNodeLike(parent) ? parent : scrollByNodeIndex.get(parent.index);
}

function rememberHiddenNode(
  node: RawSnapshotNode,
  scrollAncestor: RawSnapshotNode,
  direction: HiddenDirection | undefined,
  state: ProjectionBuildState,
): void {
  state.hiddenIndexes.add(node.index);
  if (!direction) return;
  state.hiddenDirections.set(node.index, direction);
  rememberHint(state.hintsByScrollIndex, scrollAncestor.index, direction);
}

function classifyBaseHiddenNode(
  node: RawSnapshotNode,
  parent: RawSnapshotNode | undefined,
  scrollAncestor: RawSnapshotNode,
  hiddenIndexes: ReadonlySet<number>,
  hiddenDirections: ReadonlyMap<number, HiddenDirection>,
): { direction?: HiddenDirection } | undefined {
  if (parent && hiddenIndexes.has(parent.index)) {
    return { direction: hiddenDirections.get(parent.index) };
  }
  if (!isPositiveFiniteRect(node.rect) || !isPositiveFiniteRect(scrollAncestor.rect)) {
    return undefined;
  }
  const offscreen = offscreenDirection(node.rect, scrollAncestor.rect);
  if (offscreen) return { direction: offscreen };
  if (!isRectVisibleInViewport(node.rect, scrollAncestor.rect)) return undefined;
  return undefined;
}

function suppressCollapsedPrivateAxClusters(
  nodes: RawSnapshotNode[],
  state: ProjectionBuildState,
): void {
  for (const cluster of collectCollapsedPrivateAxClusters(nodes, state)) {
    suppressCollapsedCluster(cluster, state.hiddenIndexes);
  }
  propagateSuppressionToDescendants(nodes, state);
}

function collectCollapsedPrivateAxClusters(
  nodes: RawSnapshotNode[],
  state: ProjectionBuildState,
): RawSnapshotNode[][] {
  const orderedNodes = isIndexOrdered(nodes) ? nodes : [...nodes].sort((a, b) => a.index - b.index);
  const clusters: RawSnapshotNode[][] = [];
  const collection: CollapsedClusterCollectionState = {
    activeAncestorMemo: new Map(),
    activeCluster: [],
    activeClusterIndexes: new Set(),
  };
  for (const node of orderedNodes) {
    advanceCollapsedPrivateAxCluster(node, state, collection, clusters);
  }
  clusters.push(collection.activeCluster);
  return clusters;
}

function advanceCollapsedPrivateAxCluster(
  node: RawSnapshotNode,
  projection: ProjectionBuildState,
  collection: CollapsedClusterCollectionState,
  clusters: RawSnapshotNode[][],
): void {
  const scroll = projection.scrollByNodeIndex.get(node.index);
  const evidenceKey = collapsedPrivateAxEvidenceKey(node, scroll, projection);
  if (evidenceKey) {
    collection.pendingEvidenceKey = evidenceKey;
    return;
  }
  const candidateKey = collapsedPrivateAxCandidateKey(node, scroll, projection);
  const key = candidateKey === collection.pendingEvidenceKey ? candidateKey : undefined;
  if (shouldSkipCollapsedClusterBoundary(node, key, projection, collection)) return;
  if (!key) collection.pendingEvidenceKey = undefined;
  if (key !== collection.activeKey) resetCollapsedCluster(collection, clusters, key);
  if (!key) return;
  collection.activeCluster.push(node);
  collection.activeClusterIndexes.add(node.index);
}

function shouldSkipCollapsedClusterBoundary(
  node: RawSnapshotNode,
  key: string | undefined,
  projection: ProjectionBuildState,
  collection: CollapsedClusterCollectionState,
): boolean {
  return (
    !key &&
    (projection.hiddenIndexes.has(node.index) ||
      isActiveClusterDescendant(node, projection, collection))
  );
}

function collapsedPrivateAxEvidenceKey(
  node: RawSnapshotNode,
  scroll: RawSnapshotNode | undefined,
  projection: ProjectionBuildState,
): string | undefined {
  if (!scroll || !isCollapsedHiddenPrecursor(node, scroll, projection)) return undefined;
  const edge = projection.effectiveLeadingEdgeByScrollIndex.get(scroll.index);
  return edge ? collapsedPrivateAxClusterKeyForEdge(scroll, edge) : undefined;
}

function collapsedPrivateAxCandidateKey(
  node: RawSnapshotNode,
  scroll: RawSnapshotNode | undefined,
  projection: ProjectionBuildState,
): string | undefined {
  return scroll && isCollapsedPrivateAxCandidate(node, scroll, projection)
    ? collapsedPrivateAxClusterKey(node, scroll)
    : undefined;
}

function isActiveClusterDescendant(
  node: RawSnapshotNode,
  projection: ProjectionBuildState,
  collection: CollapsedClusterCollectionState,
): boolean {
  return hasAncestorInCluster(
    node,
    collection.activeClusterIndexes,
    projection.byIndex,
    collection.activeAncestorMemo,
  );
}

function resetCollapsedCluster(
  collection: CollapsedClusterCollectionState,
  clusters: RawSnapshotNode[][],
  key: string | undefined,
): void {
  clusters.push(collection.activeCluster);
  collection.activeCluster = [];
  collection.activeClusterIndexes = new Set();
  collection.activeAncestorMemo = new Map();
  collection.activeKey = key;
}

function propagateSuppressionToDescendants(
  nodes: RawSnapshotNode[],
  state: ProjectionBuildState,
): void {
  const inheritedSuppression = new Map<number, boolean>();
  for (const node of nodes) {
    if (hasSuppressedAncestor(node, state, inheritedSuppression)) {
      state.hiddenIndexes.add(node.index);
    }
  }
}

function hasAncestorInCluster(
  node: RawSnapshotNode,
  clusterIndexes: ReadonlySet<number>,
  byIndex: ReadonlyMap<number, RawSnapshotNode>,
  memo: Map<number, boolean>,
): boolean {
  if (clusterIndexes.size === 0) return false;
  return hasAncestorMatching(node, byIndex, memo, (index) => clusterIndexes.has(index));
}

function isIndexOrdered(nodes: RawSnapshotNode[]): boolean {
  return nodes.every((node, index) => index === 0 || nodes[index - 1]!.index <= node.index);
}

function suppressCollapsedCluster(cluster: RawSnapshotNode[], hiddenIndexes: Set<number>): void {
  if (cluster.length < MIN_COLLAPSED_PRIVATE_AX_CLUSTER_SIZE) return;
  for (const node of cluster) hiddenIndexes.add(node.index);
}

function isCollapsedPrivateAxCandidate(
  node: RawSnapshotNode,
  scroll: RawSnapshotNode,
  state: ProjectionBuildState,
): boolean {
  const edge = state.effectiveLeadingEdgeByScrollIndex.get(scroll.index);
  return (
    edge !== undefined &&
    node.parentIndex === scroll.index &&
    typeof node.depth === 'number' &&
    typeof scroll.depth === 'number' &&
    node.depth > scroll.depth + 1 &&
    isPositiveFiniteRect(node.rect) &&
    isAtEffectiveLeadingEdge(node, edge)
  );
}

function isCollapsedHiddenPrecursor(
  node: RawSnapshotNode,
  scroll: RawSnapshotNode,
  state: ProjectionBuildState,
): boolean {
  return (
    state.hiddenIndexes.has(node.index) &&
    state.hiddenDirections.has(node.index) &&
    node.parentIndex === scroll.index &&
    typeof node.depth === 'number' &&
    typeof scroll.depth === 'number' &&
    node.depth === scroll.depth + 1
  );
}

function isAtEffectiveLeadingEdge(node: RawSnapshotNode, edge: { x: number; y: number }): boolean {
  return Boolean(
    node.rect &&
    Math.abs(node.rect.x - edge.x) <= PRIVATE_AX_EDGE_TOLERANCE_PX &&
    Math.abs(node.rect.y - edge.y) <= PRIVATE_AX_EDGE_TOLERANCE_PX,
  );
}

function offscreenDirection(
  rect: NonNullable<RawSnapshotNode['rect']>,
  viewport: NonNullable<RawSnapshotNode['rect']>,
): HiddenDirection | undefined {
  if (rect.y + rect.height < viewport.y) return 'above';
  if (rect.y > viewport.y + viewport.height) return 'below';
  return undefined;
}

function collapsedPrivateAxClusterKey(node: RawSnapshotNode, scroll: RawSnapshotNode): string {
  return collapsedPrivateAxClusterKeyForEdge(scroll, node.rect!);
}

function collapsedPrivateAxClusterKeyForEdge(
  scroll: RawSnapshotNode,
  edge: { x: number; y: number },
): string {
  return `${scroll.index}:${Math.round(edge.x)}:${Math.round(edge.y)}`;
}

function hasSuppressedAncestor(
  node: RawSnapshotNode,
  state: ProjectionBuildState,
  memo: Map<number, boolean>,
): boolean {
  return hasAncestorMatching(node, state.byIndex, memo, (index) => state.hiddenIndexes.has(index));
}

function hasAncestorMatching(
  node: RawSnapshotNode,
  byIndex: ReadonlyMap<number, RawSnapshotNode>,
  memo: Map<number, boolean>,
  matches: (index: number) => boolean,
): boolean {
  const cached = memo.get(node.index);
  if (cached !== undefined) return cached;
  const path: number[] = [];
  const visited = new Set<number>();
  let current: RawSnapshotNode | undefined = node;
  let result = false;
  while (current?.parentIndex !== undefined && !visited.has(current.index)) {
    visited.add(current.index);
    path.push(current.index);
    if (matches(current.parentIndex)) {
      result = true;
      break;
    }
    const parentResult = memo.get(current.parentIndex);
    if (parentResult !== undefined) {
      result = parentResult;
      break;
    }
    current = byIndex.get(current.parentIndex);
  }
  for (const index of path) memo.set(index, result);
  return result;
}

function rememberHint(
  hints: Map<number, { above: boolean; below: boolean }>,
  scrollIndex: number,
  direction: HiddenDirection,
): void {
  const hint = hints.get(scrollIndex) ?? { above: false, below: false };
  hint[direction] = true;
  hints.set(scrollIndex, hint);
}
