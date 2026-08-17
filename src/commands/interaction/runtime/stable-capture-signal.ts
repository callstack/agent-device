import type { Rect, SnapshotNode, SnapshotState } from '@agent-device/kernel/snapshot';
import { isNodeVisibleOnScreen, isViewportRootNode } from '@agent-device/contracts/snapshot';

const GEOMETRY_TOLERANCE_PX = 1;
export type StableCaptureSignal = { privateAX: boolean; nodes: SignalNode[] };
type SignalNode = { identity: string; rect?: Rect };

export function stableCaptureSignal(
  snapshot: Pick<SnapshotState, 'nodes' | 'snapshotQuality'>,
): StableCaptureSignal {
  const privateAX = snapshot.snapshotQuality?.backend === 'private-ax';
  // The runner already projects private AX by viewport intersection. Settle uses the stricter
  // center-on-screen view so edge slivers whose intersection flips by a pixel do not restart the
  // quiet window while the user-visible semantic surface remains unchanged.
  const source = privateAX
    ? snapshot.nodes.filter(
        (node) => isViewportRootNode(node) || isNodeVisibleOnScreen(node, snapshot.nodes),
      )
    : snapshot.nodes;
  const nodes = source.map(stableCaptureNodeSignal);
  nodes.sort((a, b) => sortKey(a).localeCompare(sortKey(b)));
  return { privateAX, nodes };
}

export function stableCaptureSignalsEqual(
  left: StableCaptureSignal | undefined,
  right: StableCaptureSignal,
): boolean {
  // A backend transition changes the semantic representation even if this capture happens to
  // contain equivalent nodes. Never let the quiet window span that transition.
  if (!left || left.privateAX !== right.privateAX || left.nodes.length !== right.nodes.length)
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
    identity: `${node.type ?? ''}#${node.label ?? ''}#${node.identifier ?? ''}`,
    ...(node.rect
      ? {
          rect: { ...node.rect },
        }
      : {}),
  };
}
function sortKey(node: SignalNode): string {
  const rect = node.rect;
  return `${node.identity}#${rect ? `${rect.x},${rect.y},${rect.width},${rect.height}` : ''}`;
}
