import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { DeviceInfo } from '@agent-device/kernel/device';
import type { AndroidAdbProvider } from '@agent-device/platform-android/mechanics';
import { assertCommandCall, assertRpcError } from './assertions.ts';
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

test('Provider-backed integration Android hardware-key flow sends named and raw keyevents', async () => {
  const adbCalls: string[][] = [];
  const adbProvider: AndroidAdbProvider = {
    exec: async (args) => {
      adbCalls.push([...args]);
      if (args.join(' ') === 'shell ime list -a -s') {
        return {
          stdout: 'com.callstack.agentdevice.imehelper/.TestInputMethodService\n',
          stderr: '',
          exitCode: 0,
        };
      }
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
        testIme: false,
      });

      await runProviderScenario(daemon, [
        {
          name: 'press a named key',
          command: 'hardware-key',
          positionals: ['volume-down'],
          flags: { platform: 'android', target: 'tv' },
          expectData: {
            action: 'hardware-key',
            key: 'volume-down',
            message: 'Pressed hardware key volume-down',
          },
        },
        {
          name: 'press a raw keycode',
          command: 'hardware-key',
          positionals: ['android-keycode:300'],
          flags: { platform: 'android', target: 'tv' },
          expectData: {
            action: 'hardware-key',
            key: 'android-keycode:300',
            message: 'Pressed hardware key android-keycode:300',
          },
        },
      ]);

      assertCommandCall(adbCalls, ['shell', 'input', 'keyevent', '25']);
      assertCommandCall(adbCalls, ['shell', 'input', 'keyevent', '300']);

      const callsBeforeBadKey = adbCalls.length;
      assertRpcError(
        await daemon.callCommand('hardware-key', ['volume-sideways'], {
          platform: 'android',
          target: 'tv',
        }),
        400,
        'INVALID_ARGS',
        /hardware-key key must be one of/,
      );
      assert.equal(adbCalls.length, callsBeforeBadKey);
    },
  );
});
