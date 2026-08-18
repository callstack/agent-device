import type {
  Rect,
  SnapshotCaptureBackend,
  SnapshotNode,
  SnapshotState,
} from '@agent-device/kernel/snapshot';
import { isPositiveFiniteRect } from '@agent-device/kernel/rect';
import {
  buildSnapshotNodeMap,
  isNodeVisibleOnScreen,
  isViewportRootNode,
} from '@agent-device/contracts/snapshot';

const GEOMETRY_TOLERANCE_PX = 1;
export type StableCaptureSignal = {
  captureBackend?: SnapshotCaptureBackend;
  nodes: SignalNode[];
};
type SignalNode = { identity: string; rect?: Rect };

export function stableCaptureSignal(
  snapshot: Pick<SnapshotState, 'backend' | 'nodes' | 'snapshotQuality'>,
): StableCaptureSignal {
  const captureBackend = snapshot.snapshotQuality?.backend;
  // XCTest backends can retain offscreen descendants. Settle compares their visible semantic
  // projection so internal scroll churn does not restart the quiet window.
  const source =
    snapshot.backend === 'xctest' ? stableVisibleXCTestNodes(snapshot.nodes) : snapshot.nodes;
  const nodes = source.map(stableCaptureNodeSignal);
  nodes.sort((a, b) => sortKey(a).localeCompare(sortKey(b)));
  return { captureBackend, nodes };
}

function stableVisibleXCTestNodes(nodes: SnapshotNode[]): SnapshotNode[] {
  const byIndex = buildSnapshotNodeMap(nodes);
  const viewportRects = nodes.flatMap((node) =>
    isViewportRootNode(node) && isPositiveFiniteRect(node.rect) ? [node.rect] : [],
  );
  return nodes.filter(
    (node) =>
      isViewportRootNode(node) || isNodeVisibleOnScreen(node, nodes, byIndex, viewportRects),
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
  return [node.label, node.identifier, node.value]
    .map((value) => String(value ?? '').trim())
    .join('#');
}
function sortKey(node: SignalNode): string {
  const rect = node.rect;
  return `${node.identity}#${rect ? `${rect.x},${rect.y},${rect.width},${rect.height}` : ''}`;
}
