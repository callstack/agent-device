import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { vegaPlugin } from '@agent-device/platform-vega';

const VEGA_VVD = {
  platform: 'vega',
  id: 'VirtualDevice',
  name: 'Vega Virtual Device',
  kind: 'emulator',
  target: 'tv',
  booted: true,
} satisfies DeviceInfo;

test('Vega plugin owns the Vega platform', () => {
  assert.deepEqual(vegaPlugin.platforms, ['vega']);
});

test('Vega plugin creates the Vega interactor lazily', async () => {
  const interactor = await vegaPlugin.createInteractor(VEGA_VVD, {});

  assert.equal(typeof interactor.tvRemote, 'function');
  assert.equal(typeof interactor.back, 'function');
  assert.equal(typeof interactor.home, 'function');
});
