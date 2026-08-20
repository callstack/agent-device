import { deriveMobileSnapshotHiddenContentHints } from '../snapshot/mobile-snapshot-semantics.ts';
import {
  isNodeVisibleInEffectiveViewport,
  isScrollableNodeLike,
  isViewportRootNode,
} from '@agent-device/contracts/snapshot';
import { AppError } from '@agent-device/kernel/errors';
import type { ScrollDirection } from '@agent-device/contracts/interaction';
import type {
  HiddenContentHint,
  Point,
  RawSnapshotNode,
  SnapshotNode,
} from '@agent-device/kernel/snapshot';

export type ScrollEdge = 'top' | 'bottom';

export type ScrollEdgeState = {
  canScroll: boolean;
  emptySnapshot: boolean;
  scope?: string;
};

export type ScrollEdgeTarget = {
  point?: Point;
  nodeIndex?: number;
};

const SCROLL_EDGE_PASS_LIMIT = 40;

function analyzeScrollEdgeState(
  inputNodes: readonly (RawSnapshotNode | SnapshotNode)[],
  edge: ScrollEdge,
  target: ScrollEdgeTarget = {},
): ScrollEdgeState {
  const nodes = ensureSnapshotNodes(inputNodes);
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
  };
}

export async function captureScrollEdgeState(params: {
  edge: ScrollEdge;
  target?: ScrollEdgeTarget;
  scope?: string;
  captureNodes: (scope?: string) => Promise<readonly (RawSnapshotNode | SnapshotNode)[]>;
}): Promise<ScrollEdgeState> {
  const { edge, target = {}, scope, captureNodes } = params;
  try {
    const nodes = await captureNodes(scope);
    const state = analyzeScrollEdgeState(nodes, edge, target);
    if (scope && state.emptySnapshot) {
      return await captureScrollEdgeState({ edge, target, captureNodes });
    }
    return state;
  } catch (error) {
    throw buildScrollEdgeVerificationError(edge, scope, error);
  }
}

export async function runScrollEdgePasses<TResult>(params: {
  edge: ScrollEdge;
  captureState: (scope?: string) => Promise<ScrollEdgeState>;
  scroll: () => Promise<TResult>;
}): Promise<{ passes: number; result?: TResult }> {
  const { edge, captureState, scroll } = params;
  let state = await captureState();
  if (state.scope) {
    state = await captureState(state.scope);
  }

  let passes = 0;
  let result: TResult | undefined;
  while (state.canScroll) {
    if (passes >= SCROLL_EDGE_PASS_LIMIT) {
      throw new AppError(
        'COMMAND_FAILED',
        `scroll ${edge} reached the safety limit before the snapshot showed the edge`,
        {
          hint: 'The scoped scroll container still reports hidden content. Use a smaller manual scroll + snapshot loop to inspect the current state.',
        },
      );
    }

    result = await scroll();
    passes += 1;
    state = await captureState(state.scope);
  }

  return { passes, result };
}

export function formatScrollEdgeMessage(
  direction: ScrollDirection,
  edge: ScrollEdge | undefined,
  passes: number,
  amount: number | undefined,
  pixels: number | undefined,
): string {
  if (edge && passes === 0) {
    return `Already at ${edge}; no hidden content ${edge === 'bottom' ? 'below' : 'above'} detected`;
  }
  if (edge) return `Scrolled to ${edge} with ${passes} ${direction} passes`;
  if (pixels !== undefined) return `Scrolled ${direction} by ${pixels}px`;
  if (amount !== undefined) return `Scrolled ${direction} by ${amount}`;
  return `Scrolled ${direction}`;
}

function buildScrollEdgeVerificationError(
  edge: ScrollEdge,
  scope: string | undefined,
  cause: unknown,
): AppError {
  if (scope) {
    return new AppError(
      'COMMAND_FAILED',
      `Failed to verify scroll ${edge} state for scoped container`,
      {
        scope,
        hint: `scroll ${edge} could not verify the scoped scroll container. Run snapshot -i for the current screen and retry with a visible scroll target.`,
      },
      cause,
    );
  }
  return new AppError(
    'COMMAND_FAILED',
    `Failed to verify scroll ${edge} state`,
    {
      hint: `scroll ${edge} needs a snapshot showing hidden content ${edge === 'bottom' ? 'below' : 'above'} before it will move.`,
    },
    cause,
  );
}

function ensureSnapshotNodes(nodes: readonly (RawSnapshotNode | SnapshotNode)[]): SnapshotNode[] {
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
  const byIndex = new Map(nodes.map((node) => [node.index, node]));
  const scrollables = nodes.filter((node) => isScrollableNodeLike(node) && isUsableRect(node.rect));
  if (scrollables.length === 0) {
    return null;
  }

  const targetAncestor = findNearestScrollableAncestor(target.nodeIndex, byIndex);
  if (targetAncestor) {
    return targetAncestor;
  }

  const targetPoint = target.point;
  if (targetPoint) {
    const containing = selectPointScrollContainer(scrollables, hiddenHints, edge, targetPoint);
    if (containing) return containing;
    return selectBroadScrollContainer(scrollables, hiddenHints, edge, nodes);
  }

  const viewportCenter = inferViewportCenter(nodes);
  if (viewportCenter) {
    const centered = selectPointScrollContainer(scrollables, hiddenHints, edge, viewportCenter);
    if (centered) return centered;
  }

  return selectBroadScrollContainer(scrollables, hiddenHints, edge, nodes);
}

function selectBroadScrollContainer(
  scrollables: SnapshotNode[],
  hiddenHints: Map<number, HiddenContentHint>,
  edge: ScrollEdge,
  nodes: SnapshotNode[],
): SnapshotNode | null {
  const withHiddenEdge = scrollables
    .filter((node) => hasHiddenContentAtEdge(node, hiddenHints.get(node.index), edge))
    .sort(compareBroadScrollContainer);
  if (withHiddenEdge.length > 0) return withHiddenEdge[0] ?? null;

  const visibleScrollables = scrollables
    .filter((node) => isNodeVisibleInEffectiveViewport(node, nodes))
    .sort(compareBroadScrollContainer);
  return visibleScrollables[0] ?? scrollables.sort(compareBroadScrollContainer)[0] ?? null;
}

function selectPointScrollContainer(
  scrollables: SnapshotNode[],
  hiddenHints: Map<number, HiddenContentHint>,
  edge: ScrollEdge,
  point: Point,
): SnapshotNode | null {
  const containing = scrollables
    .filter((node) => node.rect && containsPoint(node.rect, point))
    .sort(compareSpecificScrollContainer);
  const withHiddenEdge = containing.find((node) =>
    hasHiddenContentAtEdge(node, hiddenHints.get(node.index), edge),
  );
  return withHiddenEdge ?? containing[0] ?? null;
}

function inferViewportCenter(nodes: SnapshotNode[]): Point | undefined {
  const viewport = nodes
    .filter((node) => isViewportRootNode(node) && isUsableRect(node.rect))
    .sort(compareBroadScrollContainer)[0]?.rect;
  if (!viewport) return undefined;
  return {
    x: viewport.x + viewport.width / 2,
    y: viewport.y + viewport.height / 2,
  };
}

function findNearestScrollableAncestor(
  nodeIndex: number | undefined,
  byIndex: Map<number, SnapshotNode>,
): SnapshotNode | null {
  if (nodeIndex === undefined) {
    return null;
  }
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

function compareSpecificScrollContainer(a: SnapshotNode, b: SnapshotNode): number {
  return rectArea(a.rect) - rectArea(b.rect);
}

function compareBroadScrollContainer(a: SnapshotNode, b: SnapshotNode): number {
  return rectArea(b.rect) - rectArea(a.rect);
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
