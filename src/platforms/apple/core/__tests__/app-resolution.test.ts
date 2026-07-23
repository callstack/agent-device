import assert from 'node:assert/strict';
import { beforeEach, test, vi } from 'vitest';

const { mockRunSimctl } = vi.hoisted(() => ({ mockRunSimctl: vi.fn() }));

vi.mock('../apps-simctl.ts', () => ({ runSimctl: mockRunSimctl }));

import { findIosSimulatorInstalledApp } from '../app-resolution.ts';
import type { DeviceInfo } from '../../../../kernel/device.ts';

const bootedSimulator: DeviceInfo = {
  platform: 'apple',
  id: 'sim-1',
  name: 'iPhone 16',
  kind: 'simulator',
  booted: true,
};

beforeEach(() => {
  mockRunSimctl.mockReset();
  mockRunSimctl.mockResolvedValue({
    stdout: JSON.stringify({
      'com.example.demo': { CFBundleDisplayName: 'Demo' },
      'com.apple.Preferences': { CFBundleDisplayName: 'Settings' },
    }),
  });
});

test('findIosSimulatorInstalledApp verifies exact bundle ids and app-name aliases', async () => {
  assert.equal(
    await findIosSimulatorInstalledApp(bootedSimulator, 'com.example.demo'),
    'com.example.demo',
  );
  assert.equal(
    await findIosSimulatorInstalledApp(bootedSimulator, 'Settings'),
    'com.apple.Preferences',
  );
  assert.equal(
    await findIosSimulatorInstalledApp(bootedSimulator, 'com.example.missing'),
    undefined,
  );
});

test('findIosSimulatorInstalledApp does not probe a stopped simulator', async () => {
  assert.equal(
    await findIosSimulatorInstalledApp({ ...bootedSimulator, booted: false }, 'com.example.demo'),
    undefined,
  );
  assert.equal(mockRunSimctl.mock.calls.length, 0);
});
