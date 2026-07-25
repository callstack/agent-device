import assert from 'node:assert/strict';
import { beforeEach, test, vi } from 'vitest';
import { PUBLIC_COMMANDS } from '../../../command-catalog.ts';
import type { DeviceInfo } from '../../../kernel/device.ts';
import { listVegaDevices } from '../devices.ts';
import { vegaPlugin } from '../plugin.ts';

vi.mock('../devices.ts', () => ({ listVegaDevices: vi.fn() }));

const VEGA_VVD = {
  platform: 'vega',
  id: 'VirtualDevice',
  name: 'Vega Virtual Device',
  kind: 'emulator',
  target: 'tv',
  booted: true,
} satisfies DeviceInfo;

const VEGA_PHYSICAL_TV: DeviceInfo = {
  ...VEGA_VVD,
  id: 'vega-physical-tv',
  kind: 'device',
};

const VEGA_NON_TV: DeviceInfo = {
  ...VEGA_VVD,
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

  assert.ok(supportsTvRemote);
  assert.ok(unsupportedHint);
  assert.equal(supportsTvRemote(VEGA_VVD), true);
  // Device kind is owned by the descriptor bucket; the plugin adds only the TV-target gate.
  assert.equal(supportsTvRemote(VEGA_PHYSICAL_TV), true);
  assert.equal(supportsTvRemote(VEGA_NON_TV), false);
  assert.equal(unsupportedHint(VEGA_VVD), undefined);
  assert.equal(
    unsupportedHint(VEGA_PHYSICAL_TV),
    'tv-remote currently supports only Vega Virtual Devices.',
  );
  assert.equal(
    unsupportedHint(VEGA_NON_TV),
    'tv-remote currently supports only Vega Virtual Devices.',
  );

  for (const command of [
    PUBLIC_COMMANDS.open,
    PUBLIC_COMMANDS.close,
    PUBLIC_COMMANDS.back,
    PUBLIC_COMMANDS.home,
  ]) {
    const supports = vegaPlugin.capability.supportsByDefault[command];
    assert.ok(supports);
    assert.equal(supports(VEGA_VVD), true);
    assert.equal(supports(VEGA_PHYSICAL_TV), true);
    assert.equal(supports(VEGA_NON_TV), false);
  }
});

test('Vega plugin delegates discovery to the Vega inventory', async () => {
  const devices = [VEGA_VVD];
  mockListVegaDevices.mockResolvedValue(devices);

  const discovered = await vegaPlugin.discoverDevices({ platform: 'vega', target: 'tv' });

  assert.equal(discovered, devices);
  assert.equal(mockListVegaDevices.mock.calls.length, 1);
  assert.deepEqual(mockListVegaDevices.mock.calls[0], []);
});

test('Vega plugin creates the Vega interactor lazily', async () => {
  const interactor = await vegaPlugin.createInteractor(VEGA_VVD, {});

  assert.equal(typeof interactor.tvRemote, 'function');
  assert.equal(typeof interactor.back, 'function');
  assert.equal(typeof interactor.home, 'function');
});
