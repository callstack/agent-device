import {
  deriveMobileSnapshotHiddenContentHints,
  isNodeVisibleInEffectiveViewport,
} from './mobile-snapshot-semantics.ts';
import { AppError } from '../kernel/errors.ts';
import { isScrollableNodeLike } from './scrollable.ts';
import type { ScrollDirection } from '../core/scroll-gesture.ts';
import type {
  HiddenContentHint,
  Point,
  RawSnapshotNode,
  SnapshotNode,
} from '../kernel/snapshot.ts';

export type ScrollEdge = 'top' | 'bottom';

export type ScrollEdgeState = {
  canScroll: boolean;
  emptySnapshot: boolean;
  signature: string;
  scope?: string;
};

export type ScrollEdgeTarget = {
  point?: Point;
  nodeIndex?: number;
};

const SCROLL_EDGE_PASS_LIMIT = 40;

const SCROLL_SIGNATURE_RECT_PRECISION = 1;

function analyzeScrollEdgeState(
  inputNodes: readonly (RawSnapshotNode | SnapshotNode)[] | undefined,
  edge: ScrollEdge,
  target: ScrollEdgeTarget = {},
): ScrollEdgeState {
  const nodes = ensureSnapshotNodes(inputNodes ?? []);
  if (nodes.length === 0) {
    return {
      canScroll: false,
      emptySnapshot: true,
      signature: '',
    };
  }

  const hiddenHints = deriveMobileSnapshotHiddenContentHints(nodes);
  const container = selectScrollContainer(nodes, hiddenHints, edge, target);
  const signatureNodes = container ? collectSubtreeNodes(nodes, container.index) : nodes;
  const signature = buildScrollStateSignature(signatureNodes);
  if (!container) {
    return {
      canScroll: false,
      emptySnapshot: false,
      signature,
    };
  }

  const canScroll = hasHiddenContentAtEdge(container, hiddenHints.get(container.index), edge);
  return {
    canScroll,
    emptySnapshot: false,
    signature,
    scope: buildScrollContainerScope(container),
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
    const containing = scrollables
      .filter((node) => node.rect && containsPoint(node.rect, targetPoint))
      .sort(compareSpecificScrollContainer);
    if (containing.length > 0) {
      const withHiddenEdge = containing.find((node) =>
        hasHiddenContentAtEdge(node, hiddenHints.get(node.index), edge),
      );
      return withHiddenEdge ?? containing[0] ?? null;
    }
  }

  const withHiddenEdge = scrollables
    .filter((node) => hasHiddenContentAtEdge(node, hiddenHints.get(node.index), edge))
    .sort(compareBroadScrollContainer);
  if (withHiddenEdge.length > 0) {
    return withHiddenEdge[0] ?? null;
  }

  const visibleScrollables = scrollables
    .filter((node) => isNodeVisibleInEffectiveViewport(node, nodes))
    .sort(compareBroadScrollContainer);
  return visibleScrollables[0] ?? scrollables.sort(compareBroadScrollContainer)[0] ?? null;
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

function collectSubtreeNodes(nodes: SnapshotNode[], rootIndex: number): SnapshotNode[] {
  const byIndex = new Map(nodes.map((node) => [node.index, node]));
  return nodes.filter((node) => node.index === rootIndex || hasAncestor(node, rootIndex, byIndex));
}

function hasAncestor(
  node: SnapshotNode,
  ancestorIndex: number,
  byIndex: Map<number, SnapshotNode>,
): boolean {
  let current = node.parentIndex === undefined ? undefined : byIndex.get(node.parentIndex);
  while (current) {
    if (current.index === ancestorIndex) {
      return true;
    }
    current = current.parentIndex === undefined ? undefined : byIndex.get(current.parentIndex);
  }
  return false;
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

function buildScrollContainerScope(node: SnapshotNode): string | undefined {
  return [node.identifier, node.label, node.value]
    .map((value) => (typeof value === 'string' ? value.trim() : ''))
    .find(isUsefulScope);
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

function buildScrollStateSignature(nodes: SnapshotNode[]): string {
  return nodes
    .map((node) => {
      const rectSignature = node.rect
        ? ['x', 'y', 'width', 'height']
            .map((key) =>
              roundSignatureNumber(node.rect?.[key as keyof NonNullable<SnapshotNode['rect']>]),
            )
            .join(',')
        : '';
      return [
        String(node.index ?? ''),
        String(node.parentIndex ?? ''),
        String(node.type ?? ''),
        String(node.label ?? ''),
        String(node.value ?? ''),
        rectSignature,
      ].join('|');
    })
    .join('\n');
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

function roundSignatureNumber(value: unknown): string {
  return typeof value === 'number' && Number.isFinite(value)
    ? value.toFixed(SCROLL_SIGNATURE_RECT_PRECISION)
    : '';
}
