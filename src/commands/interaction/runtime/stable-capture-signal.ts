import type {
  Rect,
  SnapshotCaptureBackend,
  SnapshotNode,
  SnapshotState,
} from '@agent-device/kernel/snapshot';
import { createSnapshotVisibility, isViewportRootNode } from '@agent-device/contracts/snapshot';

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
  const visibility = createSnapshotVisibility(nodes);
  return nodes.filter((node) => isViewportRootNode(node) || visibility.isVisibleOnScreen(node));
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

export function stableCaptureSignalsHaveBroadReplacement(
  left: StableCaptureSignal | undefined,
  right: StableCaptureSignal,
): boolean {
  // A backend transition must reset the ordinary quiet window, but it must not conceal a broad
  // semantic replacement. Both signals already carry the same visible XCTest projection, and the
  // transition baseline is only armed for XCTest sessions.
  if (!left || left.nodes.length === 0 || right.nodes.length === 0) return false;
  const remainingIdentities = new Map<string, number>();
  for (const node of left.nodes) {
    remainingIdentities.set(node.identity, (remainingIdentities.get(node.identity) ?? 0) + 1);
  }
  let sharedNodes = 0;
  for (const node of right.nodes) {
    const remaining = remainingIdentities.get(node.identity) ?? 0;
    if (remaining === 0) continue;
    sharedNodes += 1;
    remainingIdentities.set(node.identity, remaining - 1);
  }
  return sharedNodes / Math.max(left.nodes.length, right.nodes.length) < 0.5;
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
