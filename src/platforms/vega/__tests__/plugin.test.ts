import assert from 'node:assert/strict';
import { beforeEach, test, vi } from 'vitest';
import { PUBLIC_COMMANDS } from '../../../command-catalog.ts';
import type { DeviceInfo } from '../../../kernel/device.ts';
import { listVegaDevices, type VegaDeviceInfo } from '../devices.ts';
import { vegaPlugin } from '../plugin.ts';

vi.mock('../devices.ts', () => ({ listVegaDevices: vi.fn() }));

const VEGA_TV = {
  platform: 'vega',
  id: 'vega-tv',
  name: 'Vega TV',
  kind: 'emulator',
  target: 'tv',
  booted: true,
} satisfies VegaDeviceInfo;

const VEGA_NON_TV: DeviceInfo = {
  ...VEGA_TV,
  id: 'vega-non-tv',
  target: 'mobile',
};

const mockListVegaDevices = vi.mocked(listVegaDevices);

beforeEach(() => {
  mockListVegaDevices.mockReset();
});

test('Vega plugin owns the Vega platform and tv-remote capability bucket', () => {
  assert.deepEqual(vegaPlugin.platforms, ['vega']);
  assert.equal(vegaPlugin.capability.bucket, 'vega');

  const supportsTvRemote = vegaPlugin.capability.supportsByDefault[PUBLIC_COMMANDS.tvRemote];
  const unsupportedHint = vegaPlugin.capability.unsupportedHintByDefault[PUBLIC_COMMANDS.tvRemote];

  assert.equal(supportsTvRemote?.(VEGA_TV), true);
  assert.equal(supportsTvRemote?.(VEGA_NON_TV), false);
  assert.equal(unsupportedHint?.(VEGA_TV), undefined);
  assert.equal(unsupportedHint?.(VEGA_NON_TV), 'tv-remote is supported only on Vega TV targets.');

  for (const command of [
    PUBLIC_COMMANDS.open,
    PUBLIC_COMMANDS.close,
    PUBLIC_COMMANDS.back,
    PUBLIC_COMMANDS.home,
  ]) {
    assert.equal(vegaPlugin.capability.supportsByDefault[command]?.(VEGA_TV), true);
    assert.equal(vegaPlugin.capability.supportsByDefault[command]?.(VEGA_NON_TV), false);
  }
});

test('Vega plugin delegates discovery to the Vega inventory', async () => {
  const devices = [VEGA_TV];
  mockListVegaDevices.mockResolvedValue(devices);

  const discovered = await vegaPlugin.discoverDevices({ platform: 'vega', target: 'tv' });

  assert.equal(discovered, devices);
  assert.equal(mockListVegaDevices.mock.calls.length, 1);
  assert.deepEqual(mockListVegaDevices.mock.calls[0], []);
});

test('Vega plugin creates the Vega interactor lazily', async () => {
  const interactor = await vegaPlugin.createInteractor(VEGA_TV, {});

  assert.equal(typeof interactor.tvRemote, 'function');
  assert.equal(typeof interactor.back, 'function');
  assert.equal(typeof interactor.home, 'function');
});
