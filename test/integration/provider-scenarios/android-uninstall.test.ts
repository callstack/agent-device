import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { DeviceInfo } from '@agent-device/kernel/device';
import type { AndroidAdbProvider } from '@agent-device/platform-android/mechanics';
import { assertCommandCall } from './assertions.ts';
import { createProviderScenarioHarness, withProviderScenarioResource } from './harness.ts';
import { runProviderScenario } from './scenario.ts';

const PROVIDER_SCENARIO_ANDROID: DeviceInfo = {
  platform: 'android',
  id: 'emulator-5554',
  name: 'Pixel',
  kind: 'emulator',
  target: 'mobile',
  booted: true,
};

test('Provider-backed integration Android uninstall removes an installed package and no-ops on a missing one', async () => {
  const adbCalls: string[][] = [];
  const adbProvider: AndroidAdbProvider = {
    exec: async (args) => {
      adbCalls.push([...args]);
      if (args.join(' ') === 'shell pm list packages') {
        return { stdout: 'package:com.example.demo\n', stderr: '', exitCode: 0 };
      }
      return { stdout: args[0] === 'uninstall' ? 'Success\n' : '', stderr: '', exitCode: 0 };
    },
  };

  await withProviderScenarioResource(
    async () =>
      await createProviderScenarioHarness({
        androidAdbProvider: () => adbProvider,
        deviceInventoryProvider: async () => [PROVIDER_SCENARIO_ANDROID],
      }),
    async (daemon) => {
      daemon.publishSession('default', {
        name: 'default',
        device: PROVIDER_SCENARIO_ANDROID,
        createdAt: Date.now(),
        actions: [],
      });

      await runProviderScenario(daemon, [
        {
          name: 'uninstall an installed package',
          command: 'uninstall',
          positionals: ['com.example.demo'],
          flags: { platform: 'android' },
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
          flags: { platform: 'android' },
          expectData: {
            platform: 'android',
            app: 'com.example.missing',
            wasInstalled: false,
            message: 'Not installed: com.example.missing',
          },
        },
      ]);

      assertCommandCall(adbCalls, ['uninstall', 'com.example.demo']);
      assert.equal(
        adbCalls.some((call) => call[0] === 'uninstall' && call.includes('com.example.missing')),
        false,
        'a package nothing installed matches must not reach adb uninstall',
      );
    },
  );
});
