import { afterEach, test, vi } from 'vitest';
import assert from 'node:assert/strict';

vi.mock('../snapshot.ts', () => ({ snapshotAndroid: vi.fn() }));

import { handleAndroidAlert } from '../alert.ts';
import { snapshotAndroid } from '../snapshot.ts';
import type { DeviceInfo } from '../../../kernel/device.ts';

const device: DeviceInfo = {
  booted: true,
  id: 'emulator-5554',
  kind: 'emulator',
  name: 'Pixel',
  platform: 'android',
};

afterEach(() => vi.restoreAllMocks());

test('Android alert get retains the normal bounded helper settle policy', async () => {
  vi.mocked(snapshotAndroid).mockResolvedValue({
    analysis: { maxDepth: 0, rawNodeCount: 0 },
    androidSnapshot: { backend: 'android-helper' },
    nodes: [],
  });

  await handleAndroidAlert(device, 'get');

  assert.deepEqual(vi.mocked(snapshotAndroid).mock.calls[0]?.[1], {
    includeHiddenContentHints: false,
  });
});
