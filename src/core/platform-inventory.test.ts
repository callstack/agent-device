import assert from 'node:assert/strict';
import { test, vi } from 'vitest';
import type { DeviceInfo } from '../kernel/device.ts';

const { listVegaDevices } = vi.hoisted(() => ({
  listVegaDevices: vi.fn(),
}));

vi.mock('../platforms/vega/devices.ts', () => ({
  listVegaDevices,
}));

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
