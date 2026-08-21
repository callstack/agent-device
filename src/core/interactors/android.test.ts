import { afterEach, expect, test, vi } from 'vitest';
import {
  attachSnapshotClickabilityEvidence,
  readSnapshotClickabilityEvidence,
} from '@agent-device/contracts/capture';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { createAndroidInteractor } from './android.ts';
import { snapshotAndroid } from '../../platforms/android/snapshot.ts';

vi.mock('../../platforms/android/snapshot.ts', () => ({
  snapshotAndroid: vi.fn(),
}));

const snapshotAndroidMock = vi.mocked(snapshotAndroid);
const device: DeviceInfo = {
  platform: 'android',
  id: 'emulator-5554',
  name: 'Pixel',
  kind: 'emulator',
  booted: true,
};

afterEach(() => {
  vi.resetAllMocks();
});

test('preserves Android clickability evidence through the interactor snapshot adapter', async () => {
  const captured = {
    nodes: [{ index: 0, identifier: 'target', rect: { x: 0, y: 0, width: 20, height: 20 } }],
    analysis: { rawNodeCount: 1, maxDepth: 0 },
    androidSnapshot: { backend: 'android-helper' as const },
  };
  const evidence = {
    kind: 'exact' as const,
    provider: 'android-helper' as const,
    clickableByNodeIndex: new Map<number, boolean | undefined>([[0, true]]),
  };
  attachSnapshotClickabilityEvidence(captured, evidence);
  snapshotAndroidMock.mockResolvedValue(captured);

  const result = await createAndroidInteractor(device).snapshot({});

  expect(readSnapshotClickabilityEvidence(result)).toEqual(evidence);
  expect(JSON.stringify(result)).not.toContain('clickable');
});
