import {
  createIosSnapshotAcquisition,
  resolveIosViewportEvidenceFromRoots,
} from '@agent-device/capture-kit/ios-snapshot-acquisition';
import type { SnapshotRuntimeAcquiredResult } from '@agent-device/contracts/interactor-types';
import { parseWebDriverSourceFacts } from './webdriver-source.ts';

const APPIUM_PRODUCER = 'appium-source' as const;

/** Turns one already-read Appium page source into acquired iOS facts. */
export function acquireWebDriverIosSnapshot(
  source: string,
  targetId?: string,
): SnapshotRuntimeAcquiredResult {
  const sourceFacts = parseWebDriverSourceFacts(source);
  const viewport =
    resolveIosViewportEvidenceFromRoots(sourceFacts.roots) ??
    ({ kind: 'missing', reason: 'not-provided' } as const);
  return createIosSnapshotAcquisition({
    producer: APPIUM_PRODUCER,
    nodes: sourceFacts.nodes,
    viewport,
    lineage: targetId ? { targetId } : {},
  });
}
