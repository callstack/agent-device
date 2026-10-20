import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { HardwareKeyToken } from '@agent-device/contracts/tv-remote';
import { createCloudWebDriverCapabilities } from './capabilities.ts';
import type { WebDriverClient } from './webdriver-client.ts';
import { createWebDriverInteractor } from './webdriver-interactor.ts';

function keyPressWorld(platform: 'android' | 'ios') {
  const transcript: string[] = [];
  const client = {
    executeScript: async (script: string, args: unknown[]) => {
      transcript.push(`${script} ${JSON.stringify(args)}`);
    },
  } as unknown as WebDriverClient;
  const interactor = createWebDriverInteractor({
    client,
    backend: platform === 'android' ? 'android' : 'xctest',
    capabilities: createCloudWebDriverCapabilities({ provider: 'test', platform }),
  });
  return { transcript, interactor };
}

test.each([
  ['volume-down', 25],
  ['android-keycode:300', 300],
] as const satisfies readonly (readonly [HardwareKeyToken, number])[])(
  'hardware key %s presses keycode %i through the driver on Android',
  async (key, keycode) => {
    const world = keyPressWorld('android');

    await world.interactor.hardwareKey!(key);

    assert.deepEqual(world.transcript, [`mobile: pressKey [{"keycode":${keycode}}]`]);
  },
);

test('a hardware key refuses on iOS, where the capability map declares no key press', async () => {
  const world = keyPressWorld('ios');

  await assert.rejects(
    () => world.interactor.hardwareKey!('volume-down'),
    (error: unknown) =>
      (error as { code?: string }).code === 'UNSUPPORTED_OPERATION' &&
      (error as { details?: { operation?: string } }).details?.operation === 'hardwareKey',
  );
  assert.deepEqual(world.transcript, []);
});
