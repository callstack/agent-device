import assert from 'node:assert/strict';
import { test } from 'vitest';
import { browserStackProvider } from './browserstack-provider.ts';
import type { CloudWebDriverProviderHost } from './provider-plugin.ts';

const HOST: CloudWebDriverProviderHost = {
  env: {
    BROWSERSTACK_USERNAME: 'user',
    BROWSERSTACK_ACCESS_KEY: 'key',
    BROWSERSTACK_WEBDRIVER_ENDPOINT: 'https://hub.test/wd/hub/',
  },
  clientVersion: '1.2.3',
  runHostCommand: async () => {
    throw new Error('BrowserStack runs no host commands');
  },
};

test('the declaration reserves the provider id and names the credential variables', () => {
  assert.equal(browserStackProvider.declaration.provider, 'browserstack');
  assert.deepEqual(browserStackProvider.declaration.credentialVariables, [
    'BROWSERSTACK_USERNAME',
    'BROWSERSTACK_ACCESS_KEY',
  ]);
  assert.equal(browserStackProvider.declaration.connection.usesCloudWebDriverLease, true);
});

test('the factory reads its hub endpoint from the environment and connects through the lazy callbacks', async () => {
  const { webDriver, connection } = browserStackProvider.create(HOST);
  assert.equal(webDriver.provider, 'browserstack');
  assert.equal(webDriver.endpoint, 'https://hub.test/wd/hub/');
  assert.equal(webDriver.profileFields.provider, 'browserstack');
  const { profile } = await connection.resolve({
    flags: {
      json: false,
      help: false,
      version: false,
      platform: 'ios',
      device: 'iPhone 16',
      providerOsVersion: '18.0',
      providerApp: 'bs://app-id',
    },
    cwd: '/',
  });
  assert.equal(profile.leaseProvider, 'browserstack');
  assert.equal(profile.device, 'iPhone 16');
});
