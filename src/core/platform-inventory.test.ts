import assert from 'node:assert/strict';
import { test, vi } from 'vitest';
import type { DeviceInfo } from '@agent-device/kernel/device';

const {
  listVegaDevices,
  listAndroidDevices,
  listHarmonyDevices,
  listAppleDevices,
  listLinuxDevices,
} = vi.hoisted(() => ({
  listVegaDevices: vi.fn(),
  listAndroidDevices: vi.fn(),
  listHarmonyDevices: vi.fn(),
  listAppleDevices: vi.fn(),
  listLinuxDevices: vi.fn(),
}));

vi.mock('../platforms/vega/devices.ts', () => ({
  listVegaDevices,
}));
vi.mock('../platforms/android/devices.ts', () => ({
  listAndroidDevices,
}));
vi.mock('../platforms/harmonyos/devices.ts', () => ({
  listHarmonyDevices,
}));
vi.mock('../platforms/apple/core/devices.ts', () => ({
  listAppleDevices,
}));
vi.mock('../platforms/linux/devices.ts', () => ({
  listLinuxDevices,
}));

import { LOCAL_DEVICE_INVENTORY_PLATFORM_SELECTORS } from '@agent-device/contracts/device';
import { listLocalDeviceInventory } from './platform-inventory.ts';

const VEGA_EMULATOR: DeviceInfo = {
  platform: 'vega',
  id: 'VirtualDevice',
  name: 'Vega Virtual Device',
  kind: 'emulator',
  target: 'tv',
  booted: true,
};

test('explicit Vega inventory delegates to the Vega device module', async () => {
  listVegaDevices.mockResolvedValueOnce([VEGA_EMULATOR]);

  const result = await listLocalDeviceInventory({
    platform: 'vega',
    target: 'tv',
    serial: VEGA_EMULATOR.id,
  });

  assert.deepEqual(result, [VEGA_EMULATOR]);
  assert.deepEqual(listVegaDevices.mock.calls[0], []);
});

test('probes every platform concurrently and keeps selector order in the result', async () => {
  // Sequential awaits made an unfiltered lookup cost the sum of every
  // toolchain probe. Each stub records when it starts and resolves only once
  // all five have started, so this deadlocks unless they genuinely overlap.
  const PLATFORM_COUNT = LOCAL_DEVICE_INVENTORY_PLATFORM_SELECTORS.length;
  let started = 0;
  let allStarted!: () => void;
  const everyProbeStarted = new Promise<void>((resolve) => {
    allStarted = resolve;
  });
  const gate = async () => {
    started += 1;
    if (started === PLATFORM_COUNT) allStarted();
    await everyProbeStarted;
  };

  listAndroidDevices.mockImplementation(async () => {
    await gate();
    return [device('android', 'android-1')];
  });
  listHarmonyDevices.mockImplementation(async () => {
    await gate();
    return [device('harmonyos', 'harmony-1')];
  });
  listAppleDevices.mockImplementation(async () => {
    await gate();
    return [device('apple', 'apple-1')];
  });
  listVegaDevices.mockImplementation(async () => {
    await gate();
    return [device('vega', 'vega-1')];
  });
  listLinuxDevices.mockImplementation(async () => {
    await gate();
    return [device('linux', 'linux-1')];
  });

  const result = await listLocalDeviceInventory({});

  assert.equal(started, PLATFORM_COUNT);
  assert.deepEqual(
    result.map((entry) => entry.id),
    ['android-1', 'harmony-1', 'apple-1', 'vega-1', 'linux-1'],
  );
});

test('a failing platform probe does not drop the devices found by the others', async () => {
  listAndroidDevices.mockRejectedValue(new Error('adb exploded'));
  listHarmonyDevices.mockResolvedValue([device('harmonyos', 'harmony-1')]);
  listAppleDevices.mockResolvedValue([device('apple', 'apple-1')]);
  listVegaDevices.mockRejectedValue(new Error('vega exploded'));
  listLinuxDevices.mockResolvedValue([device('linux', 'linux-1')]);

  const result = await listLocalDeviceInventory({});

  assert.deepEqual(
    result.map((entry) => entry.id),
    ['harmony-1', 'apple-1', 'linux-1'],
  );
});

function device(platform: DeviceInfo['platform'], id: string): DeviceInfo {
  return { platform, id, name: id, kind: 'device', booted: true };
}
