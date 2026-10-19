import { test } from 'vitest';
import type { DeviceInfo } from '@agent-device/kernel/device';
import type { AndroidAdbProvider } from '@agent-device/platform-android/mechanics';
import { assertCommandCall } from './assertions.ts';
import { createProviderScenarioHarness, withProviderScenarioResource } from './harness.ts';
import { runProviderScenario } from './scenario.ts';

const PROVIDER_SCENARIO_ANDROID_TV: DeviceInfo = {
  platform: 'android',
  id: 'emulator-5556',
  name: 'Android TV',
  kind: 'emulator',
  target: 'tv',
  booted: true,
};

test('Provider-backed integration Android TV remote flow sends D-pad keyevents', async () => {
  const adbCalls: string[][] = [];
  const adbProvider: AndroidAdbProvider = {
    exec: async (args) => {
      adbCalls.push([...args]);
      return { stdout: '', stderr: '', exitCode: 0 };
    },
  };

  await withProviderScenarioResource(
    async () =>
      await createProviderScenarioHarness({
        androidAdbProvider: () => adbProvider,
        deviceInventoryProvider: async () => [PROVIDER_SCENARIO_ANDROID_TV],
      }),
    async (daemon) => {
      await daemon.client().apps.open({
        app: 'com.android.settings',
        platform: 'android',
        serial: PROVIDER_SCENARIO_ANDROID_TV.id,
      });

      await runProviderScenario(daemon, [
        {
          name: 'move focus down',
          command: 'tv-remote',
          positionals: ['down'],
          flags: { platform: 'android', target: 'tv' },
          expectData: {
            action: 'tv-remote',
            button: 'down',
            message: 'Pressed TV remote down',
          },
        },
        {
          name: 'hold select',
          command: 'tv-remote',
          positionals: ['select'],
          flags: { platform: 'android', target: 'tv', durationMs: 500 },
          expectData: {
            action: 'tv-remote',
            button: 'select',
            durationMs: 500,
            message: 'Pressed TV remote select',
          },
        },
      ]);

      assertCommandCall(adbCalls, ['shell', 'input', 'keyevent', 'KEYCODE_DPAD_DOWN']);
      assertCommandCall(adbCalls, [
        'shell',
        'input',
        'keyevent',
        '--longpress',
        'KEYCODE_DPAD_CENTER',
      ]);
    },
  );
});
