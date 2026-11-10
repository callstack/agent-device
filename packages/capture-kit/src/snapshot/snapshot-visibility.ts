import { buildMobileSnapshotPresentation } from '../mobile-snapshot-semantics.ts';
import { type SnapshotVisibility } from '@agent-device/kernel/snapshot';
import {
  usesMobileSnapshotPresentation,
  type SnapshotState,
} from '@agent-device/contracts/snapshot';

export function buildSnapshotVisibility(params: {
  nodes: SnapshotState['nodes'];
  backend?: SnapshotState['backend'];
  snapshotRaw?: boolean;
}): SnapshotVisibility {
  const { nodes, backend, snapshotRaw } = params;
  if (snapshotRaw || !usesMobileSnapshotPresentation(backend)) {
    return {
      partial: false,
      visibleNodeCount: nodes.length,
      totalNodeCount: nodes.length,
      reasons: [],
    };
  }

  const presentation = buildMobileSnapshotPresentation(nodes);
  const reasons = new Set<SnapshotVisibility['reasons'][number]>();
  if (presentation.hiddenCount > 0) {
    reasons.add('offscreen-nodes');
  }
  if (presentation.nodes.some((node) => node.hiddenContentAbove)) {
    reasons.add('scroll-hidden-above');
  }
  if (presentation.nodes.some((node) => node.hiddenContentBelow)) {
    reasons.add('scroll-hidden-below');
  }

  return {
    partial: reasons.size > 0,
    visibleNodeCount: presentation.nodes.length,
    totalNodeCount: nodes.length,
    reasons: [...reasons],
  };
}
