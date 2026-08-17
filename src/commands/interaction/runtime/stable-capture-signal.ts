import type { SnapshotNode, SnapshotState } from '@agent-device/kernel/snapshot';
import { isNodeVisibleOnScreen, isViewportRootNode } from '@agent-device/contracts/snapshot';

const PRIVATE_AX_GEOMETRY_TOLERANCE = 4;
export type StableCaptureSignal = { privateAX: boolean; nodes: SignalNode[] };
type SignalNode = { identity: string; rect?: [number, number, number, number] };

export function stableCaptureSignal(
  snapshot: Pick<SnapshotState, 'nodes' | 'snapshotQuality'>,
): StableCaptureSignal {
  const privateAX = snapshot.snapshotQuality?.backend === 'private-ax';
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
  if (!left || left.privateAX !== right.privateAX || left.nodes.length !== right.nodes.length)
    return false;
  return left.nodes.every((node, index) => {
    const candidate = right.nodes[index];
    if (!candidate || node.identity !== candidate.identity) return false;
    if (!node.rect || !candidate.rect) return node.rect === candidate.rect;
    const tolerance = left.privateAX ? PRIVATE_AX_GEOMETRY_TOLERANCE : 0;
    return node.rect.every(
      (value, coordinate) => Math.abs(value - candidate.rect![coordinate]!) <= tolerance,
    );
  });
}

function stableCaptureNodeSignal(node: SnapshotNode): SignalNode {
  return {
    identity: `${node.type ?? ''}#${node.label ?? ''}#${node.identifier ?? ''}`,
    ...(node.rect
      ? {
          rect: [node.rect.x, node.rect.y, node.rect.width, node.rect.height] as SignalNode['rect'],
        }
      : {}),
  };
}
function sortKey(node: SignalNode): string {
  return `${node.identity}#${node.rect?.join(',') ?? ''}`;
}
