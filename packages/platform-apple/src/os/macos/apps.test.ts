import { afterEach, expect, test, vi } from 'vitest';
import type { DeviceInfo } from '@agent-device/kernel/device';

vi.mock('node:timers/promises', () => ({ setTimeout: vi.fn(async () => undefined) }));
vi.mock('./helper.ts', () => ({ quitMacOsApp: vi.fn() }));

import { quitMacOsApp } from './helper.ts';
import { closeMacOsApp } from './apps.ts';

const MACOS_DEVICE: DeviceInfo = {
  platform: 'apple',
  appleOs: 'macos',
  id: 'host-macos-local',
  name: 'Host Mac',
  kind: 'device',
  target: 'desktop',
  booted: true,
};

const mockQuitMacOsApp = vi.mocked(quitMacOsApp);

afterEach(() => {
  mockQuitMacOsApp.mockReset();
});

test('closeMacOsApp waits until an accepted termination has actually completed', async () => {
  mockQuitMacOsApp
    .mockResolvedValueOnce({
      bundleId: 'com.apple.systempreferences',
      running: true,
      terminated: true,
      forceTerminated: false,
    })
    .mockResolvedValueOnce({
      bundleId: 'com.apple.systempreferences',
      running: true,
      terminated: false,
      forceTerminated: false,
    })
    .mockResolvedValueOnce({
      bundleId: 'com.apple.systempreferences',
      running: false,
      terminated: false,
      forceTerminated: false,
    });

  await closeMacOsApp(MACOS_DEVICE, 'com.apple.systempreferences');

  expect(mockQuitMacOsApp).toHaveBeenCalledTimes(3);
});

test('closeMacOsApp fails immediately when neither termination request is accepted', async () => {
  mockQuitMacOsApp.mockResolvedValue({
    bundleId: 'com.apple.systempreferences',
    running: true,
    terminated: false,
    forceTerminated: false,
  });

  await expect(closeMacOsApp(MACOS_DEVICE, 'com.apple.systempreferences')).rejects.toThrow(
    'Failed to close macOS app com.apple.systempreferences',
  );
  expect(mockQuitMacOsApp).toHaveBeenCalledTimes(1);
});

test('closeMacOsApp bounds termination confirmation', async () => {
  mockQuitMacOsApp.mockResolvedValue({
    bundleId: 'com.apple.systempreferences',
    running: true,
    terminated: true,
    forceTerminated: false,
  });

  await expect(closeMacOsApp(MACOS_DEVICE, 'com.apple.systempreferences')).rejects.toMatchObject({
    details: { reason: 'MACOS_APP_TERMINATION_TIMEOUT', attempts: 20 },
  });
  expect(mockQuitMacOsApp).toHaveBeenCalledTimes(20);
});
