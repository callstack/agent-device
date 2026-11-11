import assert from 'node:assert/strict';
import { test } from 'vitest';
import { createCloudWebDriverCapabilities } from './capabilities.ts';
import type { WebDriverClient } from './webdriver-client.ts';
import { createWebDriverInteractor } from './webdriver-interactor.ts';

/** A client that records every method called on it, with its arguments. */
function lifecycleRecordingClient(calls: string[]): WebDriverClient {
  return new Proxy({} as WebDriverClient, {
    get:
      (_target, method) =>
      async (...args: unknown[]) => {
        calls.push(`${String(method)} ${JSON.stringify(args)}`);
      },
  });
}

// Both Appium drivers require an app id for `mobile: activateApp`; a leased session is already the
// foreground device, so opening the device sends nothing.
test('openDevice sends no driver request on either backend', async () => {
  for (const platform of ['android', 'ios'] as const) {
    const calls: string[] = [];
    const interactor = createWebDriverInteractor({
      client: lifecycleRecordingClient(calls),
      backend: platform === 'ios' ? 'xctest' : 'android',
      capabilities: createCloudWebDriverCapabilities({ provider: 'test', platform }),
    });
    await interactor.openDevice?.();
    assert.deepEqual(calls, [], platform);
  }
});

// XCUITest's `mobile: deepLink` reads `bundleId`; UiAutomator2's reads `package`.
test('a deep link names the target app in the field each driver reads', async () => {
  for (const [platform, target] of [
    ['android', { package: 'com.example.app' }],
    ['ios', { bundleId: 'com.example.app' }],
  ] as const) {
    const calls: string[] = [];
    const interactor = createWebDriverInteractor({
      client: lifecycleRecordingClient(calls),
      backend: platform === 'ios' ? 'xctest' : 'android',
      capabilities: createCloudWebDriverCapabilities({ provider: 'test', platform }),
    });
    await interactor.open('com.example.app', { url: 'example://home' });
    assert.deepEqual(calls, [
      `executeScript ${JSON.stringify(['mobile: deepLink', [{ url: 'example://home', ...target }]])}`,
    ]);
  }
});
