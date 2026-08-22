import type { RawSnapshotNode } from '@agent-device/kernel/snapshot';
import {
  buildUiHierarchySnapshot,
  parseUiHierarchyTree,
  type AndroidSnapshotAnalysis,
  type AndroidUiHierarchySnapshotOptions,
} from '../ui-hierarchy.ts';

/** XML in, presented nodes out — the production pair (`snapshotAndroid`) minus the helper capture. */
export function parseUiHierarchy(
  xml: string,
  maxNodes: number | undefined,
  options: AndroidUiHierarchySnapshotOptions,
): { nodes: RawSnapshotNode[]; truncated?: boolean; analysis: AndroidSnapshotAnalysis } {
  const { sourceNodes: _sourceNodes, ...snapshot } = buildUiHierarchySnapshot(
    parseUiHierarchyTree(xml),
    maxNodes,
    options,
  );
  return snapshot;
}
