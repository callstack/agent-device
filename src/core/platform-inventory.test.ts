import assert from 'node:assert/strict';
import { test, vi } from 'vitest';
import type { DeviceInfo } from '../kernel/device.ts';

const { discoverVegaDevices } = vi.hoisted(() => ({
  discoverVegaDevices: vi.fn(),
}));

vi.mock('../platforms/vega/plugin.ts', () => ({
  vegaPlugin: {
    discoverDevices: discoverVegaDevices,
  },
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

test('explicit Vega inventory delegates to the Vega plugin discovery seam', async () => {
  discoverVegaDevices.mockResolvedValueOnce([VEGA_EMULATOR]);

  const result = await listLocalDeviceInventory({
    platform: 'vega',
    target: 'tv',
    serial: VEGA_EMULATOR.id,
  });

  assert.deepEqual(result, [VEGA_EMULATOR]);
  assert.deepEqual(discoverVegaDevices.mock.calls[0], [
    {
      platform: 'vega',
      target: 'tv',
      serial: VEGA_EMULATOR.id,
    },
  ]);
});
