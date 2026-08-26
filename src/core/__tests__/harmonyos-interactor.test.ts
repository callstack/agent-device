import { expect, test, vi } from 'vitest';
import type { DeviceInfo } from '@agent-device/kernel/device';

const { invalidateHarmonyGestureViewport, runHarmonyHdc } = vi.hoisted(() => ({
  invalidateHarmonyGestureViewport: vi.fn(),
  runHarmonyHdc: vi.fn(async () => ({ stdout: '', stderr: '', exitCode: 0 })),
}));

vi.mock('../../platforms/harmonyos/hdc.ts', () => ({ runHarmonyHdc }));
vi.mock('../../platforms/harmonyos/snapshot.ts', () => ({
  snapshotHarmony: vi.fn(async () => ({
    nodes: [{ index: 0, type: 'Button', label: 'Continue' }],
    truncated: false,
  })),
  readHarmonyGestureViewport: vi.fn(),
  invalidateHarmonyGestureViewport,
}));

import { createHarmonyInteractor } from '../interactors/harmonyos.ts';

const device: DeviceInfo = {
  platform: 'harmonyos',
  id: 'emulator',
  name: 'emulator',
  kind: 'emulator',
  booted: true,
};

test('harmonyos snapshot stamps its channel and producer', async () => {
  const result = await createHarmonyInteractor(device).snapshot();

  expect(result.backend).toBe('harmonyos-arkui');
  expect(result.producer).toBe('harmonyos-uitest');
  expect(result.nodes).toEqual([{ index: 0, type: 'Button', label: 'Continue' }]);
});

test('harmonyos keyboard dismiss invalidates gesture viewport through the Back route', async () => {
  await expect(createHarmonyInteractor(device).keyboardDismiss?.()).resolves.toEqual({
    kind: 'acknowledged',
  });

  expect(runHarmonyHdc).toHaveBeenCalledWith(device, [
    'shell',
    'uitest',
    'uiInput',
    'keyEvent',
    'Back',
  ]);
  expect(invalidateHarmonyGestureViewport).toHaveBeenCalledWith(device);
});
