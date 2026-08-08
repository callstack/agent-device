import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { DeviceInfo } from '@agent-device/kernel/device';
import {
  countDeviceInventoryByGroup,
  LOCAL_DEVICE_INVENTORY_PLATFORM_SELECTORS,
} from './device-inventory.ts';

test('local inventory includes HarmonyOS and Vega before the fallback Linux desktop', () => {
  assert.deepEqual(LOCAL_DEVICE_INVENTORY_PLATFORM_SELECTORS, [
    'android',
    'harmonyos',
    'apple',
    'vega',
    'linux',
  ]);
});

test('inventory counts Vega as its own platform family', () => {
  const devices: DeviceInfo[] = [
    {
      platform: 'vega',
      id: 'VirtualDevice',
      name: 'Vega Virtual Device',
      kind: 'emulator',
      target: 'tv',
      booted: true,
    },
  ];

  const counts = countDeviceInventoryByGroup(devices);

  assert.deepEqual(counts.vega, { available: 1, booted: 1 });
  assert.deepEqual(counts.android, { available: 0, booted: 0 });
});
