import assert from 'node:assert/strict';
import { test } from 'vitest';
import { assertCommandCall } from './assertions.ts';
import { createAndroidSettingsWorld } from './android-world.ts';
import { runProviderScenario } from './scenario.ts';

test('Provider-backed integration Android uninstall removes an installed package and no-ops on a missing one', async () => {
  const world = await createAndroidSettingsWorld();

  try {
    await world.daemon.client().apps.open({ app: 'settings', ...world.selection });
    await runProviderScenario(world.daemon, [
      {
        name: 'uninstall an installed package',
        command: 'uninstall',
        positionals: ['com.example.demo'],
        flags: world.selection,
        expectData: {
          platform: 'android',
          app: 'com.example.demo',
          wasInstalled: true,
          appId: 'com.example.demo',
          message: 'Uninstalled: com.example.demo',
        },
      },
      {
        name: 'uninstall a package nothing installed matches',
        command: 'uninstall',
        positionals: ['com.example.missing'],
        flags: world.selection,
        expectData: {
          platform: 'android',
          app: 'com.example.missing',
          wasInstalled: false,
          message: 'Not installed: com.example.missing',
        },
      },
    ]);

    assertCommandCall(world.adbCalls, ['uninstall', 'com.example.demo']);
    assert.equal(
      world.adbCalls.some(
        (call) => call[0] === 'uninstall' && call.includes('com.example.missing'),
      ),
      false,
      'a package nothing installed matches must not reach adb uninstall',
    );
  } finally {
    await world.close();
  }
});
