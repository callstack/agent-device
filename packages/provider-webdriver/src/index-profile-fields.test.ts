import { test } from 'vitest';
import assert from 'node:assert/strict';
import { BUNDLED_CLOUD_WEBDRIVER_PROVIDERS } from './index.ts';

test('every bundled runtime reads the profile fields declared under its provider id', () => {
  const host = {
    env: {},
    clientVersion: 'test',
    runHostCommand: async () => {
      throw new Error('declarations need no host command');
    },
  };
  for (const bundled of BUNDLED_CLOUD_WEBDRIVER_PROVIDERS) {
    const { webDriver } = bundled.create(host);
    assert.equal(webDriver.provider, bundled.declaration.provider);
    assert.equal(webDriver.profileFields.provider, bundled.declaration.provider);
  }
});
