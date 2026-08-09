import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { DeviceInfo } from '@agent-device/kernel/device';
import {
  countDeviceInventoryByGroup,
  filterDeviceInventoryProjection,
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

test('local inventory projection filters device kind and fresh boot state', () => {
  const devices: DeviceInfo[] = [
    {
      platform: 'apple',
      appleOs: 'ios',
      target: 'mobile',
      id: 'booted',
      name: 'Booted iPhone',
      kind: 'simulator',
      booted: true,
    },
    {
      platform: 'apple',
      appleOs: 'ios',
      target: 'mobile',
      id: 'shutdown',
      name: 'Shutdown iPhone',
      kind: 'simulator',
      booted: false,
    },
    {
      platform: 'apple',
      appleOs: 'ios',
      target: 'mobile',
      id: 'physical',
      name: 'Physical iPhone',
      kind: 'device',
      booted: true,
    },
    {
      platform: 'apple',
      appleOs: 'tvos',
      target: 'tv',
      id: 'booted-tv',
      name: 'Booted Apple TV',
      kind: 'simulator',
      booted: true,
    },
  ];

  assert.deepEqual(
    filterDeviceInventoryProjection(devices, {
      target: 'mobile',
      kind: 'simulator',
      booted: true,
    }).map((device) => device.id),
    ['booted'],
  );
});
