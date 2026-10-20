import assert from 'node:assert/strict';
import { test } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import { createCloudWebDriverCapabilities } from './capabilities.ts';
import type { WebDriverClient } from './webdriver-client.ts';
import { createWebDriverInteractor } from './webdriver-interactor.ts';

/**
 * The hardware-button legs (#3848): UiAutomator2 registers no pressButton and presses the volume
 * and power keycodes through `mobile: pressKey`; XCUITest carries volume through
 * `mobile: pressButton` and exposes no power press, so an iOS session refuses power from its
 * declared capability map before the driver is asked.
 */

function recordingClient(transcript: string[]): WebDriverClient {
  return {
    executeScript: async (script: string, args: unknown[]) => {
      transcript.push(`${script} ${JSON.stringify(args)}`);
    },
  } as unknown as WebDriverClient;
}

test('Android volume presses ride the mobile pressKey volume keycodes', async () => {
  const transcript: string[] = [];
  const interactor = createWebDriverInteractor({
    client: recordingClient(transcript),
    backend: 'android',
    capabilities: createCloudWebDriverCapabilities({ provider: 'test', platform: 'android' }),
  });
  await interactor.volumeUp!();
  await interactor.volumeDown!();
  assert.deepEqual(transcript, [
    'mobile: pressKey [{"keycode":24}]',
    'mobile: pressKey [{"keycode":25}]',
  ]);
});

test('iOS volume presses ride mobile pressButton and power refuses before the driver', async () => {
  const transcript: string[] = [];
  const ios = createWebDriverInteractor({
    client: recordingClient(transcript),
    backend: 'xctest',
    capabilities: createCloudWebDriverCapabilities({ provider: 'test', platform: 'ios' }),
  });
  await ios.volumeUp!();
  await ios.volumeDown!();
  assert.deepEqual(transcript, [
    'mobile: pressButton [{"name":"volumeup"}]',
    'mobile: pressButton [{"name":"volumedown"}]',
  ]);

  const powerClient = {
    executeScript: async () => {
      throw new Error('the iOS power refusal must reach the driver');
    },
  } as unknown as WebDriverClient;
  const powerIos = createWebDriverInteractor({
    client: powerClient,
    backend: 'xctest',
    capabilities: createCloudWebDriverCapabilities({ provider: 'test', platform: 'ios' }),
  });
  await assert.rejects(powerIos.power!(), (error: unknown) => {
    return error instanceof AppError && error.code === 'UNSUPPORTED_OPERATION';
  });
});

test('Android power presses KEYCODE_POWER through mobile pressKey', async () => {
  const transcript: string[] = [];
  const android = createWebDriverInteractor({
    client: recordingClient(transcript),
    backend: 'android',
    capabilities: createCloudWebDriverCapabilities({ provider: 'test', platform: 'android' }),
  });
  await android.power!();
  assert.deepEqual(transcript, ['mobile: pressKey [{"keycode":26}]']);
});
