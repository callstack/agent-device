import type { RawSnapshotNode, SnapshotOptions } from '@agent-device/kernel/snapshot';
import {
  buildUiHierarchySnapshot,
  parseUiHierarchyTree,
  type AndroidSnapshotAnalysis,
} from '../ui-hierarchy.ts';

/** XML in, presented nodes out — the production pair (`snapshotAndroid`) minus the helper capture. */
export function parseUiHierarchy(
  xml: string,
  maxNodes: number | undefined,
  options: SnapshotOptions,
): { nodes: RawSnapshotNode[]; truncated?: boolean; analysis: AndroidSnapshotAnalysis } {
  const { sourceNodes: _sourceNodes, ...snapshot } = buildUiHierarchySnapshot(
    parseUiHierarchyTree(xml),
    maxNodes,
    options,
  );
  return snapshot;
}
