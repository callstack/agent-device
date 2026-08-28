import {
  type AndroidSystemChromeProvenance,
  isAndroidSystemChromeWindowResourceId,
} from '@agent-device/contracts/android-system-chrome';
import type { AndroidSiblingOrderEvidence } from '@agent-device/contracts/capture';
import { isScrollableType, normalizeSnapshotScope } from '@agent-device/contracts/snapshot';
import {
  foldSnapshotRect,
  serializeRegularSnapshotPresentationNode,
} from '@agent-device/contracts/snapshot-presentation';
import type { RawSnapshotNode, Rect, SnapshotOptions } from '@agent-device/kernel/snapshot';
import { isPositiveFiniteRect, pickLargestRect } from '@agent-device/kernel/rect';
import {
  isAgentTarget,
  readAndroidSiblingOrder,
  type AndroidNode,
  type AndroidUiHierarchy,
} from './ui-hierarchy-node.ts';
import { collectAndroidHiddenNodes } from './ui-hierarchy-visibility.ts';
import { scopePresentedAndroidSnapshot } from './ui-hierarchy-scope.ts';
import { isCollectionContainerType, shouldIncludeAndroidNode } from './ui-hierarchy-inclusion.ts';
import {
  createAndroidSnapshotPresentationNode,
  isAndroidSnapshotPresentationFailure,
  validateAndroidRegularPresentation,
  createAndroidSnapshotPresentationBudget,
  type AndroidSnapshotPresentationBudget,
  type AndroidSnapshotPresentationOptions,
} from './snapshot-presentation.ts';

type AndroidRawSnapshotNode = RawSnapshotNode & AndroidSystemChromeProvenance;

const ANDROID_PRESENTATION_WORK_UNITS_PER_NODE = 128;

export type AndroidSnapshotAnalysis = {
  rawNodeCount: number;
  maxDepth: number;
};

export type AndroidUiHierarchySnapshotOptions = SnapshotOptions & {
  androidPresentation?: AndroidSnapshotPresentationOptions;
};

export type AndroidBuiltSnapshot = {
  nodes: AndroidRawSnapshotNode[];
  sourceNodes: AndroidUiHierarchy[];
  occlusionContext: {
    nodes: readonly AndroidRawSnapshotNode[];
    sourceIndexByNodeIndex: ReadonlyMap<number, number>;
    androidSiblingOrderByNodeIndex: ReadonlyMap<number, AndroidSiblingOrderEvidence>;
  };
  truncated?: boolean;
  analysis: AndroidSnapshotAnalysis;
};

type AndroidSnapshotBuildState = {
  nodes: AndroidRawSnapshotNode[];
  sourceNodes: AndroidUiHierarchy[];
  maxNodes?: number;
  maxDepth: number;
  options: AndroidUiHierarchySnapshotOptions;
  analysis: AndroidSnapshotAnalysis;
  interactiveDescendantMemo: Map<AndroidNode, boolean>;
  /** Subtrees the regular projection hides (invisible / stale window). Empty for raw. */
  hidden: ReadonlySet<AndroidNode>;
  /** Largest helper-reported application/window frame, used as the regular viewport fallback. */
  viewport?: Rect;
  presentationBudget: AndroidSnapshotPresentationBudget;
  presentationNodes: ReturnType<typeof createAndroidSnapshotPresentationNode>[];
  truncated: boolean;
};

export function buildUiHierarchySnapshot(
  tree: AndroidUiHierarchy,
  maxNodes: number | undefined,
  options: AndroidUiHierarchySnapshotOptions,
): AndroidBuiltSnapshot {
  const requestedDepth = options.depth ?? Number.POSITIVE_INFINITY;
  const scope = normalizeSnapshotScope(options.scope);
  const analysis = analyzeAndroidTree(tree);
  const presentationBudget = createAndroidSnapshotPresentationBudget(
    options.androidPresentation,
    Math.max(1024, analysis.rawNodeCount * ANDROID_PRESENTATION_WORK_UNITS_PER_NODE),
  );
  const state: AndroidSnapshotBuildState = {
    nodes: [],
    sourceNodes: [],
    ...(maxNodes !== undefined ? { maxNodes } : {}),
    // Under --scope, depth is relative to the scope root, which is only known once the tree is
    // presented: walk unbounded and cut after scoping.
    maxDepth: scope ? Number.POSITIVE_INFINITY : requestedDepth,
    options,
    analysis,
    interactiveDescendantMemo: new Map(),
    // C3: raw is the acquired tree (normalization only); regular additionally hides what Android
    // marks invisible and stale application windows. Daemon publication alone owns occlusion.
    hidden: new Set(),
    presentationBudget,
    presentationNodes: [],
    truncated: false,
  };

  try {
    presentationBudget.check('work');
    state.viewport = resolveAndroidSnapshotViewport(tree, presentationBudget);
    state.hidden = options.raw ? new Set() : collectAndroidHiddenNodes(tree, presentationBudget);
    for (const root of tree.children) {
      walkUiHierarchyNode(state, root, 0);
      if (state.truncated) break;
    }
    if (!options.raw) {
      validateAndroidRegularPresentation(
        state.presentationNodes,
        state.viewport,
        presentationBudget,
      );
    }
    const occlusionContextNodes = state.nodes;
    const sourceIndexBySourceNode = new Map(
      state.sourceNodes.map((sourceNode, index) => [sourceNode, index]),
    );
    const { nodes, sourceNodes } = scope
      ? scopePresentedAndroidSnapshot(
          state,
          tree.children,
          scope,
          requestedDepth,
          presentationBudget,
        )
      : state;
    const snapshot = {
      nodes,
      sourceNodes,
      occlusionContext: {
        nodes: occlusionContextNodes,
        sourceIndexByNodeIndex: new Map(
          sourceNodes.flatMap((sourceNode, index) => {
            const sourceIndex = sourceIndexBySourceNode.get(sourceNode);
            const nodeIndex = nodes[index]?.index;
            return sourceIndex === undefined || nodeIndex === undefined
              ? []
              : [[nodeIndex, sourceIndex] as const];
          }),
        ),
        androidSiblingOrderByNodeIndex: collectAndroidSiblingOrders(state.sourceNodes),
      },
      analysis: state.analysis,
    };
    return state.truncated ? { ...snapshot, truncated: true } : snapshot;
  } catch (error) {
    if (isAndroidSnapshotPresentationFailure(error)) {
      error.analysis ??= state.analysis;
      throw error;
    }
    throw error;
  }
}

function collectAndroidSiblingOrders(
  sourceNodes: readonly AndroidNode[],
): ReadonlyMap<number, AndroidSiblingOrderEvidence> {
  const groupByParent = new Map<AndroidNode, number>();
  const orders = new Map<number, AndroidSiblingOrderEvidence>();
  for (const [index, sourceNode] of sourceNodes.entries()) {
    const siblingOrder = readAndroidSiblingOrder(sourceNode);
    if (!siblingOrder) continue;
    let group = groupByParent.get(siblingOrder.parent);
    if (group === undefined) {
      group = groupByParent.size;
      groupByParent.set(siblingOrder.parent, group);
    }
    orders.set(index, { group, order: siblingOrder.order });
  }
  return orders;
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
  state.presentationBudget.check('work');
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
    currentWindowRect,
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
  return state.options.raw ? node.rect : foldSnapshotRect(node.rect, windowRect, ancestorClip);
}

function appendAndroidNodeIfPresented(
  state: AndroidSnapshotBuildState,
  node: AndroidNode,
  parentIndex: number | undefined,
  ancestorHittable: boolean,
  ancestorCollection: boolean,
  ancestorSystemChrome: boolean,
  effectiveRect: Rect | undefined,
  windowRect: Rect | undefined,
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
  return appendAndroidSnapshotNode(
    state,
    node,
    parentIndex,
    systemChrome,
    effectiveRect,
    windowRect,
  );
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
  windowRect: Rect | undefined,
): number {
  const currentIndex = state.nodes.length;
  // Snapshot filtering removes Compose layout wrappers. Keep depth aligned with
  // the retained parent edge, rather than the source tree's depth: otherwise a
  // fixed sibling that follows scroll content can be re-parented under the last
  // retained row by normalizeSnapshotTree's depth fallback (#1377).
  state.sourceNodes.push(node);
  const rawNode = createAndroidRawSnapshotNode(state, node, parentIndex, systemChrome);
  publishAndroidPresentationNode(state, node, rawNode, effectiveRect, windowRect);
  return currentIndex;
}

function createAndroidRawSnapshotNode(
  state: AndroidSnapshotBuildState,
  node: AndroidNode,
  parentIndex: number | undefined,
  systemChrome: boolean,
): AndroidRawSnapshotNode {
  return {
    index: state.nodes.length,
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
}

function publishAndroidPresentationNode(
  state: AndroidSnapshotBuildState,
  node: AndroidNode,
  rawNode: AndroidRawSnapshotNode,
  effectiveRect: Rect | undefined,
  windowRect: Rect | undefined,
): void {
  const presentationNode = createAndroidSnapshotPresentationNode(
    rawNode,
    effectiveRect,
    !state.options.raw && isAndroidScrollClipNode(node),
    windowRect,
  );
  state.presentationNodes.push(presentationNode);
  state.nodes.push(
    state.options.raw
      ? presentationNode.raw
      : serializeRegularSnapshotPresentationNode(presentationNode),
  );
}

function resolveAndroidSnapshotViewport(
  root: AndroidUiHierarchy,
  budget: AndroidSnapshotPresentationBudget,
): Rect | undefined {
  const windowRects: Rect[] = [];
  const stack = [...root.children];
  while (stack.length > 0) {
    budget.check('work');
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
