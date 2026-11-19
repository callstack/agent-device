import assert from 'node:assert/strict';
import { test } from 'vitest';

import webos from './index.ts';

import type { AgentDevicePlugin } from 'agent-device/plugins';

function providerOf<P extends AgentDevicePlugin>(plugin: P) {
  const [contribution] = plugin.contributes;
  if (contribution.kind !== 'provider') throw new Error('expected a provider contribution');
  return contribution as Extract<P['contributes'][number], { kind: 'provider' }>;
}


test('the plugin connection leases an Android TV device and passes on the requested TV', () => {
  const { connection } = providerOf(webos());

  assert.deepEqual(connection.resolve({ flags: { device: 'living-room' } }).profile, {
    leaseProvider: 'webos',
    platform: 'android',
    target: 'tv',
    device: 'living-room',
  });
  assert.deepEqual(connection.resolve({ flags: {} }).profile, {
    leaseProvider: 'webos',
    platform: 'android',
    target: 'tv',
  });
});

test('verify defers the TV and app to session open, naming the plugin default TV', async () => {
  const verified = await providerOf(webos({ device: 'living-room' })).connection.verify({ flags: {} });

  assert.equal(verified.service, 'LG webOS');
  assert.deepEqual(verified.device, { status: 'deferred', name: 'living-room' });
  assert.deepEqual(verified.app, { status: 'deferred' });
});
