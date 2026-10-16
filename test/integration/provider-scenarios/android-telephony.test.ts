import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { DeviceInfo } from '@agent-device/kernel/device';
import type { AndroidAdbProvider } from '@agent-device/platform-android/mechanics';
import { assertRpcError } from './assertions.ts';
import { createProviderScenarioHarness, withProviderScenarioResource } from './harness.ts';
import { runProviderScenario } from './scenario.ts';

const PROVIDER_SCENARIO_ANDROID_EMULATOR: DeviceInfo = {
  platform: 'android',
  id: 'emulator-5554',
  name: 'Pixel',
  kind: 'emulator',
  target: 'mobile',
  booted: true,
};

const PROVIDER_SCENARIO_ANDROID_PHONE: DeviceInfo = {
  ...PROVIDER_SCENARIO_ANDROID_EMULATOR,
  id: 'R5CT1234567',
  name: 'Pixel 9',
  kind: 'device',
};

function recordingAdbProvider(reply: (args: readonly string[]) => string = () => 'OK\n') {
  const calls: string[][] = [];
  const provider: AndroidAdbProvider = {
    exec: async (args) => {
      calls.push([...args]);
      return { stdout: reply(args), stderr: '', exitCode: 0 };
    },
  };
  return { calls, provider };
}

const SMS_TEXT = `Don't "stop"\nC:\\videos`;

function emulatorConsoleCalls(calls: readonly string[][]): string[][] {
  return calls.map((call) => call.slice(call.indexOf('emu'))).filter((call) => call[0] === 'emu');
}

test('Provider-backed integration Android emulator telephony flow drives the emulator console', async () => {
  const adb = recordingAdbProvider();

  await withProviderScenarioResource(
    async () =>
      await createProviderScenarioHarness({
        androidAdbProvider: () => adb.provider,
        deviceInventoryProvider: async () => [PROVIDER_SCENARIO_ANDROID_EMULATOR],
      }),
    async (daemon) => {
      daemon.publishSession('default', {
        name: 'default',
        device: PROVIDER_SCENARIO_ANDROID_EMULATOR,
        createdAt: Date.now(),
        actions: [],
      });

      await runProviderScenario(daemon, [
        {
          name: 'ring',
          command: 'telephony',
          positionals: ['call', '5551234'],
          flags: { platform: 'android' },
          expectData: {
            action: 'call',
            number: '5551234',
            message: 'Simulated an incoming call from 5551234',
          },
        },
        {
          name: 'hang up',
          command: 'telephony',
          positionals: ['cancel', '5551234'],
          flags: { platform: 'android' },
          expectData: { action: 'cancel', number: '5551234' },
        },
        {
          name: 'text',
          command: 'telephony',
          positionals: ['sms', '+15551234567', SMS_TEXT],
          flags: { platform: 'android' },
          expectData: { action: 'sms', number: '+15551234567', textLength: SMS_TEXT.length },
        },
      ]);

      assert.deepEqual(emulatorConsoleCalls(adb.calls), [
        ['emu', 'gsm', 'call', '5551234'],
        ['emu', 'gsm', 'cancel', '5551234'],
        ['emu', 'sms', 'send', '+15551234567', String.raw`Don't "stop"\nC:\\videos`],
      ]);
      assert.deepEqual(
        daemon.session('default')?.actions.map((action) => action.command),
        ['telephony', 'telephony', 'telephony'],
      );
    },
  );
});

test('Provider-backed integration Android telephony reports a console refusal with its reason', async () => {
  const adb = recordingAdbProvider(() => 'KO: no call with this number\n');

  await withProviderScenarioResource(
    async () =>
      await createProviderScenarioHarness({
        androidAdbProvider: () => adb.provider,
        deviceInventoryProvider: async () => [PROVIDER_SCENARIO_ANDROID_EMULATOR],
      }),
    async (daemon) => {
      daemon.publishSession('default', {
        name: 'default',
        device: PROVIDER_SCENARIO_ANDROID_EMULATOR,
        createdAt: Date.now(),
        actions: [],
      });

      const data = assertRpcError(
        await daemon.callCommand('telephony', ['accept', '5551234'], { platform: 'android' }),
        'COMMAND_FAILED',
        /refused telephony accept/,
      );
      assert.equal((data.details as Record<string, unknown>)?.reason, 'telephony-console-refused');
      assert.deepEqual(emulatorConsoleCalls(adb.calls), [['emu', 'gsm', 'accept', '5551234']]);
    },
  );
});

test('Provider-backed integration Android telephony refuses a physical device before adb', async () => {
  const adb = recordingAdbProvider();

  await withProviderScenarioResource(
    async () =>
      await createProviderScenarioHarness({
        androidAdbProvider: () => adb.provider,
        deviceInventoryProvider: async () => [PROVIDER_SCENARIO_ANDROID_PHONE],
      }),
    async (daemon) => {
      daemon.publishSession('default', {
        name: 'default',
        device: PROVIDER_SCENARIO_ANDROID_PHONE,
        createdAt: Date.now(),
        actions: [],
      });

      const data = assertRpcError(
        await daemon.callCommand('telephony', ['call', '5551234'], { platform: 'android' }),
        'UNSUPPORTED_OPERATION',
        /telephony is not supported on this device/,
      );
      assert.equal((data.details as Record<string, unknown>)?.reason, 'unsupported-device-kind');
      assert.deepEqual(emulatorConsoleCalls(adb.calls), []);
    },
  );
});
