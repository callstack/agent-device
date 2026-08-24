import type {
  SnapshotClickabilityEvidence,
  SnapshotOcclusionContextEvidence,
} from '@agent-device/contracts/capture';
import type { RawSnapshotNode } from '@agent-device/kernel/snapshot';
import {
  createAndroidSnapshotCapture,
  type AndroidSnapshotCapture,
} from '../../platforms/android/snapshot-capture.ts';

export function makeAndroidSnapshotCapture(
  nodes: RawSnapshotNode[],
  options: {
    clickability?: Extract<SnapshotClickabilityEvidence, { provider: 'android-helper' }>;
    occlusionContext?: SnapshotOcclusionContextEvidence;
  } = {},
): AndroidSnapshotCapture {
  return createAndroidSnapshotCapture(
    {
      nodes,
      analysis: { rawNodeCount: nodes.length, maxDepth: 0 },
      androidSnapshot: { backend: 'android-helper' },
      quality: { state: 'healthy', backend: 'android-helper' },
    },
    {
      clickability: options.clickability ?? {
        kind: 'exact',
        provider: 'android-helper',
        clickableByNodeIndex: new Map(),
      },
      ...(options.occlusionContext ? { occlusionContext: options.occlusionContext } : {}),
    },
  );
}
