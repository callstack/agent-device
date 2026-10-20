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

test('Provider-backed integration Android TV remote flow sends navigation, hardware, and raw keyevents', async () => {
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
        ...['volume-down', 'media-play-pause', 'android-keycode:300'].map((button) => ({
          name: `press ${button}`,
          command: 'tv-remote' as const,
          positionals: [button],
          flags: { platform: 'android' as const, target: 'tv' as const },
          expectData: { action: 'tv-remote', button, message: `Pressed TV remote ${button}` },
        })),
      ]);

      for (const code of ['25', '85', '300']) {
        assertCommandCall(adbCalls, ['shell', 'input', 'keyevent', code]);
      }
      for (const button of ['volume-sideways', 'android-keycode:0', 'android-keycode:2147483648']) {
        const callsBefore = adbCalls.length;
        assertRpcError(
          await daemon.callCommand('tv-remote', [button], { platform: 'android', target: 'tv' }),
          400,
          'INVALID_ARGS',
          /tv-remote button/,
        );
        assert.equal(adbCalls.length, callsBefore);
      }

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

test('Android phones refuse TV hardware and raw buttons before adb dispatch', async () => {
  const phone: DeviceInfo = {
    ...PROVIDER_SCENARIO_ANDROID_TV,
    id: 'emulator-5568',
    name: 'Phone',
    target: 'mobile',
  };
  const adbCalls: string[][] = [];
  await withProviderScenarioResource(
    async () =>
      await createProviderScenarioHarness({
        androidAdbProvider: () => ({
          exec: async (args) => {
            adbCalls.push([...args]);
            return { stdout: '', stderr: '', exitCode: 0 };
          },
        }),
        deviceInventoryProvider: async () => [phone],
      }),
    async (daemon) => {
      await daemon.client().apps.open({
        app: 'com.android.settings',
        platform: 'android',
        serial: phone.id,
        testIme: false,
      });
      for (const button of ['volume-down', 'android-keycode:25']) {
        const callsBefore = adbCalls.length;
        const error = assertRpcError(
          await daemon.callCommand('tv-remote', [button], { platform: 'android' }),
          500,
          'UNSUPPORTED_OPERATION',
          /tv-remote is not supported on this device/,
        );
        assert.deepEqual(error.details, { reason: 'unsupported-device-kind', dispatched: 'no' });
        assert.equal(adbCalls.length, callsBefore);
      }
    },
  );
});
