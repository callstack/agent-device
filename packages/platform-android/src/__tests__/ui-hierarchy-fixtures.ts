import {
  buildUiHierarchySnapshot,
  parseUiHierarchyTree,
  type AndroidUiHierarchySnapshotOptions,
} from '../ui-hierarchy.ts';
import { buildAndroidSnapshotClickabilityEvidence } from '../snapshot-clickability.ts';
import { createAndroidSnapshotCapture } from '../snapshot-capture.ts';

/** XML in, presented nodes out — the production pair (`snapshotAndroid`) minus the helper capture. */
export function parseUiHierarchy(
  xml: string,
  maxNodes: number | undefined,
  options: AndroidUiHierarchySnapshotOptions,
): ReturnType<typeof createAndroidSnapshotCapture> {
  const built = buildUiHierarchySnapshot(parseUiHierarchyTree(xml), maxNodes, options);
  const { sourceNodes: _sourceNodes, occlusionContext, ...snapshot } = built;
  return createAndroidSnapshotCapture(
    {
      ...snapshot,
      androidSnapshot: { backend: 'android-helper' },
      quality: { state: 'healthy', backend: 'android-helper' },
    },
    {
      clickability: buildAndroidSnapshotClickabilityEvidence(built),
      occlusionContext,
    },
  );
}
