import { interpretIosReactNativeValue } from '@agent-device/capture-kit/ios-react-native-value';
import {
  createIosSnapshotAcquisition,
  resolveIosViewportEvidenceFromRoots,
} from '@agent-device/capture-kit/ios-snapshot-acquisition';
import type { SnapshotRuntimeAcquiredResult } from '@agent-device/contracts/interactor-types';
import { acquireProviderKeyboard } from '@agent-device/contracts/tap-keyboard-occlusion';
import { parseWebDriverSourceFacts } from './webdriver-source.ts';

const APPIUM_PRODUCER = 'appium-source' as const;

/** Turns one already-read Appium page source into acquired iOS facts. */
export function acquireWebDriverIosSnapshot(
  source: string,
  targetId?: string,
  visibility?: boolean | 'unsupported' | 'failed',
): SnapshotRuntimeAcquiredResult {
  const sourceFacts = parseWebDriverSourceFacts(source);
  const viewport =
    resolveIosViewportEvidenceFromRoots(sourceFacts.roots) ??
    ({ kind: 'missing', reason: 'not-provided' } as const);
  return createIosSnapshotAcquisition({
    producer: APPIUM_PRODUCER,
    viewport,
    ...acquireProviderKeyboard({
      nodes: sourceFacts.nodes.map(interpretIosReactNativeValue),
      viewport: viewport.kind === 'missing' ? null : viewport.rect,
      visibility,
    }),
    lineage: targetId ? { targetId } : {},
  });
}
