import { expect, test } from 'vitest';
import { createCloudWebDriverRuntime } from './runtime.ts';
import { consumeAllProfileFields } from './profile-fields.fixtures.ts';

test('publishes eager provider metadata without loading a WebDriver session', async () => {
  const runtime = createCloudWebDriverRuntime({
    clientVersion: 'test',
    provider: 'webdriver-test',
    endpoint: 'https://webdriver.test/wd/hub/',
    platform: 'android',
    deviceName: 'Test device',
    profileFields: consumeAllProfileFields('webdriver-test'),
  });

  try {
    expect(runtime.provider).toBe('webdriver-test');
    expect(runtime.platformRuntimeModule.owner).toEqual({
      kind: 'provider-runtime',
      provider: 'webdriver-test',
      instance: 'android',
    });
  } finally {
    await runtime.shutdown();
  }
});
