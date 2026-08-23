import {
  type AndroidSystemChromeProvenance,
  isAndroidSystemChromeWindowResourceId,
} from '@agent-device/contracts/android-system-chrome';
import { isScrollableType, normalizeSnapshotScope } from '@agent-device/contracts/snapshot';
import type { RawSnapshotNode, Rect, SnapshotOptions } from '@agent-device/kernel/snapshot';
import { isPositiveFiniteRect, pickLargestRect } from '@agent-device/kernel/rect';
import { isAgentTarget, type AndroidNode, type AndroidUiHierarchy } from './ui-hierarchy-node.ts';
import { collectAndroidHiddenNodes } from './ui-hierarchy-visibility.ts';
import { scopePresentedAndroidSnapshot } from './ui-hierarchy-scope.ts';
import { isCollectionContainerType, shouldIncludeAndroidNode } from './ui-hierarchy-inclusion.ts';
import {
  createAndroidSnapshotPresentationNode,
  effectiveAndroidRect,
  serializeAndroidRegularPresentationNode,
} from './snapshot-presentation.ts';

type AndroidRawSnapshotNode = RawSnapshotNode & AndroidSystemChromeProvenance;

export type AndroidSnapshotAnalysis = {
  rawNodeCount: number;
  maxDepth: number;
};

export type AndroidBuiltSnapshot = {
  nodes: AndroidRawSnapshotNode[];
  sourceNodes: AndroidUiHierarchy[];
  truncated?: boolean;
  analysis: AndroidSnapshotAnalysis;
};

type AndroidSnapshotBuildState = {
  nodes: AndroidRawSnapshotNode[];
  sourceNodes: AndroidUiHierarchy[];
  maxNodes?: number;
  maxDepth: number;
  options: SnapshotOptions;
  analysis: AndroidSnapshotAnalysis;
  interactiveDescendantMemo: Map<AndroidNode, boolean>;
  /** Subtrees the regular projection hides (invisible / stale window / covered). Empty for raw. */
  hidden: ReadonlySet<AndroidNode>;
  /** Largest helper-reported application/window frame, used as the regular viewport fallback. */
  viewport?: Rect;
  truncated: boolean;
};

export function buildUiHierarchySnapshot(
  tree: AndroidUiHierarchy,
  maxNodes: number | undefined,
  options: SnapshotOptions,
): AndroidBuiltSnapshot {
  const requestedDepth = options.depth ?? Number.POSITIVE_INFINITY;
  const scope = normalizeSnapshotScope(options.scope);
  const viewport = resolveAndroidSnapshotViewport(tree);
  const state: AndroidSnapshotBuildState = {
    nodes: [],
    sourceNodes: [],
    ...(maxNodes !== undefined ? { maxNodes } : {}),
    // Under --scope, depth is relative to the scope root, which is only known once the tree is
    // presented: walk unbounded and cut after scoping.
    maxDepth: scope ? Number.POSITIVE_INFINITY : requestedDepth,
    options,
    analysis: analyzeAndroidTree(tree),
    interactiveDescendantMemo: new Map(),
    // C3: raw is the acquired tree (normalization only); regular additionally hides what Android
    // marks invisible, stale application windows, and covered same-window surfaces.
    hidden: options.raw ? new Set() : collectAndroidHiddenNodes(tree),
    ...(viewport ? { viewport } : {}),
    truncated: false,
  };

  for (const root of tree.children) {
    walkUiHierarchyNode(state, root, 0);
    if (state.truncated) break;
  }

  const { nodes, sourceNodes } = scope
    ? scopePresentedAndroidSnapshot(state, tree.children, scope, requestedDepth)
    : state;
  const snapshot = { nodes, sourceNodes, analysis: state.analysis };
  return state.truncated ? { ...snapshot, truncated: true } : snapshot;
}

/**
 * Chrome provenance is stamped HERE, while the tree still has the wrapper that
 * carries it. `shouldIncludeAndroidNode` drops `status_bar*`/`navigation_bar*`
 * wrappers and re-parents their children upward, so downstream classifiers see
 * a clock/battery/wifi leaf sitting next to real content with nothing left to
 * say which region it came from. Recording it on the way down (like
 * `ancestorHittable`) means the answer is identical in every capture shape —
 * `--raw` keeps the wrapper, a default capture drops it, both stamp the same
 * descendants.
 */
function walkUiHierarchyNode(
  state: AndroidSnapshotBuildState,
  node: AndroidNode,
  depth: number,
  parentIndex?: number,
  ancestorHittable: boolean = false,
  ancestorCollection: boolean = false,
  ancestorSystemChrome: boolean = false,
  ancestorWindowRect?: Rect,
  ancestorClip?: Rect,
): void {
  if (shouldStopAndroidWalk(state, node, depth)) return;
  const currentWindowRect = node.windowRect ?? ancestorWindowRect ?? state.viewport;
  const effectiveRect = resolveAndroidEffectiveRect(state, node, ancestorClip, currentWindowRect);
  const currentIndex = appendAndroidNodeIfPresented(
    state,
    node,
    parentIndex,
    ancestorHittable,
    ancestorCollection,
    ancestorSystemChrome,
    effectiveRect,
  );
  const nextAncestorHittable = ancestorHittable || isAgentTarget(node);
  const nextAncestorCollection = ancestorCollection || isCollectionContainerType(node.type);
  const nextAncestorClip = resolveAndroidDescendantClip(state, node, effectiveRect, ancestorClip);
  walkAndroidChildren(
    state,
    node,
    depth,
    currentIndex,
    nextAncestorHittable,
    nextAncestorCollection,
    ancestorSystemChrome || isAndroidSystemChromeWindowResourceId(node.identifier),
    currentWindowRect,
    nextAncestorClip,
  );
}

function shouldStopAndroidWalk(
  state: AndroidSnapshotBuildState,
  node: AndroidNode,
  depth: number,
): boolean {
  if (state.maxNodes !== undefined && state.nodes.length >= state.maxNodes) {
    state.truncated = true;
    return true;
  }
  return depth > state.maxDepth || state.hidden.has(node);
}

function resolveAndroidEffectiveRect(
  state: AndroidSnapshotBuildState,
  node: AndroidNode,
  ancestorClip: Rect | undefined,
  windowRect: Rect | undefined,
): Rect | undefined {
  return state.options.raw ? node.rect : effectiveAndroidRect(node.rect, windowRect, ancestorClip);
}

function appendAndroidNodeIfPresented(
  state: AndroidSnapshotBuildState,
  node: AndroidNode,
  parentIndex: number | undefined,
  ancestorHittable: boolean,
  ancestorCollection: boolean,
  ancestorSystemChrome: boolean,
  effectiveRect: Rect | undefined,
): number | undefined {
  if (
    !state.options.raw &&
    !shouldIncludeAndroidNode(
      node,
      state.options,
      ancestorHittable,
      hasInteractiveDescendant(state, node),
      ancestorCollection,
    )
  ) {
    return parentIndex;
  }
  const systemChrome =
    ancestorSystemChrome || isAndroidSystemChromeWindowResourceId(node.identifier);
  return appendAndroidSnapshotNode(state, node, parentIndex, systemChrome, effectiveRect);
}

function resolveAndroidDescendantClip(
  state: AndroidSnapshotBuildState,
  node: AndroidNode,
  effectiveRect: Rect | undefined,
  ancestorClip: Rect | undefined,
): Rect | undefined {
  if (state.options.raw || !isAndroidScrollClipNode(node)) return ancestorClip;
  return effectiveRect;
}

function walkAndroidChildren(
  state: AndroidSnapshotBuildState,
  node: AndroidNode,
  depth: number,
  parentIndex: number | undefined,
  ancestorHittable: boolean,
  ancestorCollection: boolean,
  ancestorSystemChrome: boolean,
  ancestorWindowRect: Rect | undefined,
  ancestorClip: Rect | undefined,
): void {
  for (const child of node.children) {
    walkUiHierarchyNode(
      state,
      child,
      depth + 1,
      parentIndex,
      ancestorHittable,
      ancestorCollection,
      ancestorSystemChrome,
      ancestorWindowRect,
      ancestorClip,
    );
    if (state.truncated) return;
  }
}

function appendAndroidSnapshotNode(
  state: AndroidSnapshotBuildState,
  node: AndroidNode,
  parentIndex: number | undefined,
  systemChrome: boolean,
  effectiveRect: Rect | undefined,
): number {
  const currentIndex = state.nodes.length;
  // Snapshot filtering removes Compose layout wrappers. Keep depth aligned with
  // the retained parent edge, rather than the source tree's depth: otherwise a
  // fixed sibling that follows scroll content can be re-parented under the last
  // retained row by normalizeSnapshotTree's depth fallback (#1377).
  state.sourceNodes.push(node);
  const rawNode: AndroidRawSnapshotNode = {
    index: currentIndex,
    type: node.type ?? undefined,
    label: node.label ?? undefined,
    value: node.value ?? undefined,
    identifier: node.identifier ?? undefined,
    bundleId: node.packageName ?? undefined,
    rect: node.rect,
    enabled: node.enabled,
    focused: node.focused,
    visibleToUser: node.visibleToUser,
    hittable: isAgentTarget(node) || undefined,
    depth: compactedAndroidNodeDepth(state.nodes, parentIndex),
    parentIndex,
    ...androidScrollActionHints(node, state.hidden),
    ...(systemChrome ? { systemChrome: true } : {}),
  };
  const presentationNode = createAndroidSnapshotPresentationNode(rawNode, effectiveRect);
  state.nodes.push(
    state.options.raw
      ? presentationNode.raw
      : serializeAndroidRegularPresentationNode(presentationNode),
  );
  return currentIndex;
}

function resolveAndroidSnapshotViewport(root: AndroidUiHierarchy): Rect | undefined {
  const windowRects: Rect[] = [];
  const stack = [...root.children];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (isPositiveFiniteRect(node.windowRect)) windowRects.push(node.windowRect);
    stack.push(...node.children);
  }
  return pickLargestRect(windowRects) ?? undefined;
}

function isAndroidScrollClipNode(node: AndroidNode): boolean {
  return node.scrollable === true && isScrollableType(node.type);
}

function compactedAndroidNodeDepth(
  nodes: AndroidRawSnapshotNode[],
  parentIndex: number | undefined,
): number {
  return parentIndex === undefined ? 0 : (nodes[parentIndex]?.depth ?? -1) + 1;
}

function hasInteractiveDescendant(state: AndroidSnapshotBuildState, node: AndroidNode): boolean {
  const cached = state.interactiveDescendantMemo.get(node);
  if (cached !== undefined) return cached;
  for (const child of node.children) {
    if (
      !state.hidden.has(child) &&
      child.visibleToUser !== false &&
      (isAgentTarget(child) || hasInteractiveDescendant(state, child))
    ) {
      state.interactiveDescendantMemo.set(node, true);
      return true;
    }
  }
  state.interactiveDescendantMemo.set(node, false);
  return false;
}

/**
 * Scroll-action hints (`hiddenContentAbove/Below`) for the presented node, from the helper's
 * can-scroll-* attributes. Derived per projection over the children that projection shows: the
 * overflow estimate that tells a horizontal list from a vertical one must not count children the
 * regular projection hides, and raw must count them all.
 */
function androidScrollActionHints(
  node: AndroidNode,
  hidden: ReadonlySet<AndroidNode>,
): { hiddenContentAbove?: true; hiddenContentBelow?: true } {
  if (!isVerticalScrollableNode(node, hidden)) return {};
  return {
    ...(node.canScrollBackward ? { hiddenContentAbove: true as const } : {}),
    ...(node.canScrollForward ? { hiddenContentBelow: true as const } : {}),
  };
}

function isVerticalScrollableNode(node: AndroidNode, hidden: ReadonlySet<AndroidNode>): boolean {
  if (!node.scrollable || !isScrollableType(node.type)) return false;
  const type = `${node.type ?? ''}`.toLowerCase();
  if (type.includes('horizontalscrollview')) return false;
  const overflow = estimateChildOverflow(node, hidden);
  if (overflow && overflow.horizontal > overflow.vertical && overflow.horizontal > 16) {
    return false;
  }
  return true;
}

function estimateChildOverflow(
  node: AndroidNode,
  hidden: ReadonlySet<AndroidNode>,
): { horizontal: number; vertical: number } | null {
  const children = node.children.filter(
    (child) => !hidden.has(child) && child.visibleToUser !== false,
  );
  if (!node.rect || children.length === 0) return null;
  const childRects = children.map((child) => child.rect).filter((rect) => rect !== undefined);
  if (childRects.length === 0) return null;
  const minX = Math.min(...childRects.map((rect) => rect.x));
  const maxX = Math.max(...childRects.map((rect) => rect.x + rect.width));
  const minY = Math.min(...childRects.map((rect) => rect.y));
  const maxY = Math.max(...childRects.map((rect) => rect.y + rect.height));
  return {
    horizontal: Math.max(0, maxX - minX - node.rect.width),
    vertical: Math.max(0, maxY - minY - node.rect.height),
  };
}

function analyzeAndroidTree(root: AndroidNode): AndroidSnapshotAnalysis {
  let rawNodeCount = 0;
  let maxDepth = 0;
  const stack = [...root.children];
  while (stack.length > 0) {
    const node = stack.pop() as AndroidNode;
    rawNodeCount += 1;
    maxDepth = Math.max(maxDepth, node.depth);
    stack.push(...node.children);
  }
  return { rawNodeCount, maxDepth };
}
