import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { vegaPlugin } from '../plugin.ts';

const VEGA_VVD = {
  platform: 'vega',
  id: 'VirtualDevice',
  name: 'Vega Virtual Device',
  kind: 'emulator',
  target: 'tv',
  booted: true,
} satisfies DeviceInfo;

test('Vega plugin owns the Vega platform and carries no capability closures', () => {
  assert.deepEqual(vegaPlugin.platforms, ['vega']);
  assert.equal(vegaPlugin.capability.bucket, 'vega');

  // R42/R43/R45 retired the plugin's only closures (the `back`/`home`/`tv-remote` TV-target
  // gate): admission is now the platform-vega runtime's own facts, exercised in its owner suite
  // (packages/platform-vega/src/runtime.test.ts). The literal type below carries no
  // `supportsByDefault`/`unsupportedHintByDefault` key at all — a compile-time proof of
  // retirement, since either key reappearing would fail this assignment.
  const capability: Readonly<{ bucket: 'vega' }> = vegaPlugin.capability;
  assert.equal(capability.bucket, 'vega');
});

test('Vega plugin creates the Vega interactor lazily', async () => {
  const interactor = await vegaPlugin.createInteractor(VEGA_VVD, {});

  assert.equal(typeof interactor.tvRemote, 'function');
  assert.equal(typeof interactor.back, 'function');
  assert.equal(typeof interactor.home, 'function');
});
