import assert from 'node:assert/strict';
import { test } from 'vitest';

import webos from './index.ts';

test('the plugin connection leases an Android TV device and passes on the requested TV', () => {
  const { connection } = webos();

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
  const verified = await webos({ device: 'living-room' }).connection.verify({ flags: {} });

  assert.equal(verified.service, 'LG webOS');
  assert.deepEqual(verified.device, { status: 'deferred', name: 'living-room' });
  assert.deepEqual(verified.app, { status: 'deferred' });
});
