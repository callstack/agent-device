import { resolveIosViewportEvidenceFromRoots } from '@agent-device/capture-kit/ios-snapshot-engine';
import {
  deriveIosSnapshotAcquisitionResidue,
  IOS_SNAPSHOT_PRODUCER_CAPABILITIES,
} from '@agent-device/capture-kit/ios-snapshot-planning';
import type { SnapshotRuntimeAcquiredResult } from '@agent-device/contracts/interactor-types';
import type { WebDriverClient } from './webdriver-client.ts';
import { parseWebDriverSourceFacts } from './webdriver-source.ts';

const APPIUM_PRODUCER = IOS_SNAPSHOT_PRODUCER_CAPABILITIES['appium-source'];

export async function captureWebDriverIosSnapshot(
  client: Pick<WebDriverClient, 'source'>,
  targetId?: string,
): Promise<SnapshotRuntimeAcquiredResult> {
  return acquireWebDriverIosSnapshot(await client.source(), targetId);
}

export function acquireWebDriverIosSnapshot(
  source: string,
  targetId?: string,
): SnapshotRuntimeAcquiredResult {
  const sourceFacts = parseWebDriverSourceFacts(source);
  const viewport =
    resolveIosViewportEvidenceFromRoots(sourceFacts.roots) ??
    ({ kind: 'missing', reason: 'not-provided' } as const);
  return {
    stage: 'acquired',
    acquisition: {
      producer: 'appium-source',
      intent: 'full',
      nodes: sourceFacts.nodes,
      viewport,
      lineage: targetId ? { targetId } : {},
      residue: deriveIosSnapshotAcquisitionResidue(APPIUM_PRODUCER, viewport),
    },
  };
}
