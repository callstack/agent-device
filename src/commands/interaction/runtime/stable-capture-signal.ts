import type {
  Rect,
  SnapshotCaptureBackend,
  SnapshotNode,
  SnapshotState,
} from '@agent-device/kernel/snapshot';
import {
  isPositiveFiniteRect,
  isRectVisibleInViewport,
  pickLargestRect,
} from '@agent-device/kernel/rect';
import {
  isTapPointInsideViewport,
  isViewportRootNode,
  resolveViewportRect,
} from '@agent-device/contracts/snapshot';
import { projectIosScrollVisibility } from '../../../snapshot/ios-scroll-visibility.ts';

const GEOMETRY_TOLERANCE_PX = 1;
export type StableCaptureSignal = {
  captureBackend?: SnapshotCaptureBackend;
  nodes: SignalNode[];
};
type SignalNode = { identity: string; rect?: Rect };
type StableVisibilityContext = {
  largestRootViewport: Rect | null;
  nodes: SnapshotNode[];
  rootViewports: Rect[];
  hiddenIndexes: ReadonlySet<number>;
  scrollByNodeIndex: ReadonlyMap<number, Pick<SnapshotNode, 'rect'>>;
};

export function stableCaptureSignal(
  snapshot: Pick<SnapshotState, 'backend' | 'nodes' | 'snapshotQuality'>,
): StableCaptureSignal {
  // Settle compares a visible semantic projection within one capture backend. Backend trees may
  // retain offscreen scroll descendants, and letting that internal churn into the signal keeps an
  // otherwise quiet screen alive for the full budget. The center-on-screen rule also absorbs edge
  // slivers whose intersection flips by a pixel.
  const source =
    snapshot.backend === 'xctest'
      ? stableVisibleNodes(
          snapshot.nodes,
          projectIosScrollVisibility(snapshot.nodes, snapshot.snapshotQuality?.backend),
        )
      : snapshot.nodes;
  const nodes = source.map(stableCaptureNodeSignal);
  nodes.sort((a, b) => sortKey(a).localeCompare(sortKey(b)));
  return { captureBackend: snapshot.snapshotQuality?.backend, nodes };
}

function stableVisibleNodes(
  nodes: SnapshotNode[],
  projection: ReturnType<typeof projectIosScrollVisibility>,
): SnapshotNode[] {
  const rootViewports = nodes.flatMap((node) =>
    isViewportRootNode(node) && isPositiveFiniteRect(node.rect) ? [node.rect] : [],
  );
  const context: StableVisibilityContext = {
    largestRootViewport: pickLargestRect(rootViewports),
    nodes,
    rootViewports,
    hiddenIndexes: projection.hiddenIndexes,
    scrollByNodeIndex: projection.scrollByNodeIndex,
  };
  return nodes.filter((node) => isStableVisibleNode(node, context));
}

function isStableVisibleNode(node: SnapshotNode, context: StableVisibilityContext): boolean {
  if (context.hiddenIndexes.has(node.index)) return false;
  if (isViewportRootNode(node)) return true;
  const rect = node.rect;
  const semantic = hasStableSemanticIdentity(node);
  if (!rect) return semantic;
  if (!isPositiveFiniteRect(rect) || isNegligibleStructure(rect, semantic)) return false;
  const clippingAncestor = context.scrollByNodeIndex.get(node.index);
  if (clippingAncestor?.rect && !isRectVisibleInViewport(node.rect!, clippingAncestor.rect)) {
    return false;
  }
  return isTapPointInsideViewport(rect, resolveStableViewport(rect, context));
}

function isNegligibleStructure(rect: Rect, semantic: boolean): boolean {
  return !semantic && (rect.width <= GEOMETRY_TOLERANCE_PX || rect.height <= GEOMETRY_TOLERANCE_PX);
}

function resolveStableViewport(rect: Rect, context: StableVisibilityContext): Rect | null {
  // Private AX is simulator-only and normally has one app-sized root. Keep the shared multi-window
  // selection semantics without rescanning the full node tree for every leaf.
  return (
    pickLargestRect(
      context.rootViewports.filter((candidate) => isTapPointInsideViewport(rect, candidate)),
    ) ??
    context.largestRootViewport ??
    resolveViewportRect(context.nodes, rect)
  );
}

export function stableCaptureSignalsEqual(
  left: StableCaptureSignal | undefined,
  right: StableCaptureSignal,
): boolean {
  if (
    !left ||
    left.captureBackend !== right.captureBackend ||
    left.nodes.length !== right.nodes.length
  )
    return false;
  return left.nodes.every((node, index) => {
    const candidate = right.nodes[index];
    if (!candidate || node.identity !== candidate.identity) return false;
    if (!node.rect || !candidate.rect) return node.rect === candidate.rect;
    const nodeRect = node.rect;
    const candidateRect = candidate.rect;
    return (['x', 'y', 'width', 'height'] as const).every(
      (coordinate) =>
        Math.abs(Math.round(nodeRect[coordinate]) - Math.round(candidateRect[coordinate])) <=
        GEOMETRY_TOLERANCE_PX,
    );
  });
}

function stableCaptureNodeSignal(node: SnapshotNode): SignalNode {
  return {
    identity: `${node.type ?? ''}#${stableSemanticIdentity(node)}`,
    ...(node.rect
      ? {
          rect: { ...node.rect },
        }
      : {}),
  };
}
function stableSemanticIdentity(node: SnapshotNode): string {
  return stableSemanticParts(node).join('#');
}
function hasStableSemanticIdentity(node: SnapshotNode): boolean {
  return stableSemanticParts(node).some(Boolean);
}
function stableSemanticParts(node: SnapshotNode): string[] {
  return [node.label, node.identifier, node.value].map((value) =>
    typeof value === 'string' ? value.trim() : String(value ?? '').trim(),
  );
}
function sortKey(node: SignalNode): string {
  const rect = node.rect;
  return `${node.identity}#${rect ? `${rect.x},${rect.y},${rect.width},${rect.height}` : ''}`;
}
