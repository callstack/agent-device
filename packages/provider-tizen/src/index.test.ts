import assert from 'node:assert/strict';
import { test } from 'vitest';

import tizen from './index.ts';

import type { AgentDevicePlugin } from 'agent-device/plugins';

function providerOf<P extends AgentDevicePlugin>(plugin: P) {
  const [contribution] = plugin.contributes;
  if (contribution.kind !== 'provider') throw new Error('expected a provider contribution');
  return contribution as Extract<P['contributes'][number], { kind: 'provider' }>;
}

test('the plugin connection leases an Android TV device and passes on the requested TV', () => {
  const { connection } = providerOf(tizen());

  assert.deepEqual(connection.resolve({ flags: { device: '192.0.2.10' } }).profile, {
    leaseProvider: 'tizen',
    platform: 'android',
    target: 'tv',
    device: '192.0.2.10',
  });
  assert.deepEqual(connection.resolve({ flags: {} }).profile, {
    leaseProvider: 'tizen',
    platform: 'android',
    target: 'tv',
  });
});

test('verify defers the TV and app to session open, naming the plugin default TV', async () => {
  const verified = await providerOf(tizen({ device: '192.0.2.10' })).connection.verify({
    flags: {},
  });

  assert.equal(verified.service, 'Samsung Tizen');
  assert.deepEqual(verified.device, { status: 'deferred', name: '192.0.2.10' });
  assert.deepEqual(verified.app, { status: 'deferred' });
});
