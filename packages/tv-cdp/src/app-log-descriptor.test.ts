import assert from 'node:assert/strict';
import { test } from 'vitest';

import { appLogDescriptorCodec } from './app-log-descriptor.ts';

const codec = appLogDescriptorCodec('webos-cdp', 'webOS');
const descriptor = {
  transport: 'webos-cdp',
  tv: 'living-room',
  appBundleId: 'com.example.app',
  outputPath: '/tmp/app.log',
};

test('an encoded app-log descriptor decodes back to the same TV and app', () => {
  assert.deepEqual(codec.decode(codec.encode(descriptor)), { status: 'decoded', descriptor });
});

test('a descriptor from another transport or with a missing field is invalid', () => {
  const { tv: _tv, ...withoutTv } = descriptor;
  const bodies: Parameters<typeof codec.decode>[0][] = [
    { ...descriptor, transport: 'tizen-cdp' },
    withoutTv,
    { ...descriptor, appBundleId: 7 },
    { ...descriptor, outputPath: null },
  ];

  for (const body of bodies) {
    assert.deepEqual(codec.decode(body), {
      status: 'invalid',
      message: 'Invalid webOS app-log descriptor',
    });
  }
});
