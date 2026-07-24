import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { DeviceInfo } from '../kernel/device.ts';
import {
  countDeviceInventoryByGroup,
  LOCAL_DEVICE_INVENTORY_PLATFORM_SELECTORS,
} from './device-inventory.ts';

test('local inventory includes Vega before the fallback Linux desktop', () => {
  assert.deepEqual(LOCAL_DEVICE_INVENTORY_PLATFORM_SELECTORS, [
    'android',
    'apple',
    'vega',
    'linux',
  ]);
});

test('inventory counts Vega as its own platform family', () => {
  const devices: DeviceInfo[] = [
    {
      platform: 'vega',
      id: 'vega-emulator',
      name: 'Vega TV Emulator',
      kind: 'emulator',
      target: 'tv',
      booted: true,
    },
    {
      platform: 'vega',
      id: 'vega-device',
      name: 'Vega TV',
      kind: 'device',
      target: 'tv',
      booted: false,
    },
  ];

  const counts = countDeviceInventoryByGroup(devices);

  assert.deepEqual(counts.vega, { available: 2, booted: 1 });
  assert.deepEqual(counts.android, { available: 0, booted: 0 });
});
