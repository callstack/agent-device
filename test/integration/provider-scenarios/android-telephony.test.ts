import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'vitest';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { parseReplayScriptDetailed } from '@agent-device/ad-script';
import { assertRpcError } from './assertions.ts';
import { createAndroidSettingsWorld } from './android-world.ts';
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

const SMS_TEXT = `Don't "stop"\nC:\\videos`;

function emulatorConsoleCalls(calls: readonly string[][]): string[][] {
  return calls.map((call) => call.slice(call.indexOf('emu'))).filter((call) => call[0] === 'emu');
}

test('Provider-backed integration Android emulator telephony flow drives the emulator console and records its commands', async () => {
  const world = await createAndroidSettingsWorld({
    device: PROVIDER_SCENARIO_ANDROID_EMULATOR,
    onAdbExec: (args) =>
      args[0] === 'emu' ? { stdout: 'OK\n', stderr: '', exitCode: 0 } : undefined,
  });

  try {
    const client = world.daemon.client();
    const opened = await client.apps.open({
      app: 'settings',
      ...world.selection,
      saveScript: true,
    });
    assert.equal(opened.device?.id, PROVIDER_SCENARIO_ANDROID_EMULATOR.id);

    await runProviderScenario(world.daemon, [
      {
        name: 'ring',
        command: 'telephony',
        positionals: ['call', '5551234'],
        flags: world.selection,
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
        flags: world.selection,
        expectData: { action: 'cancel', number: '5551234' },
      },
      {
        name: 'text',
        command: 'telephony',
        positionals: ['sms', '+15551234567', SMS_TEXT],
        flags: world.selection,
        expectData: { action: 'sms', number: '+15551234567', textLength: SMS_TEXT.length },
      },
    ]);

    assert.deepEqual(emulatorConsoleCalls(world.adbCalls), [
      ['emu', 'gsm', 'call', '5551234'],
      ['emu', 'gsm', 'cancel', '5551234'],
      ['emu', 'sms', 'send', '+15551234567', String.raw`Don't "stop"\nC:\\videos`],
    ]);

    await client.command.wait({ selector: 'label="Apps"', ...world.selection });
    const published = await client.sessions.saveScript({
      path: path.join(world.tempRoot, 'telephony.ad'),
    });
    const actions = parseReplayScriptDetailed(
      fs.readFileSync(published.savedScript, 'utf8'),
    ).actions;
    assert.equal(published.actionCount, actions.length);
    assert.deepEqual(
      actions.filter((action) => action.command === 'telephony').map((action) => action.command),
      ['telephony', 'telephony', 'telephony'],
    );
  } finally {
    await world.close();
  }
});

test('Provider-backed integration Android telephony reports a console refusal with its reason', async () => {
  const world = await createAndroidSettingsWorld({
    onAdbExec: (args) =>
      args[0] === 'emu'
        ? { stdout: 'KO: no call with this number\n', stderr: '', exitCode: 0 }
        : undefined,
  });

  try {
    await world.daemon.client().apps.open({ app: 'settings', ...world.selection });
    const data = assertRpcError(
      await world.daemon.callCommand('telephony', ['accept', '5551234'], world.selection),
      'COMMAND_FAILED',
      /refused telephony accept/,
    );
    assert.equal((data.details as Record<string, unknown>)?.reason, 'telephony-console-refused');
    assert.deepEqual(emulatorConsoleCalls(world.adbCalls), [['emu', 'gsm', 'accept', '5551234']]);
  } finally {
    await world.close();
  }
});

test('Provider-backed integration Android telephony refuses a physical device before the emulator console', async () => {
  const world = await createAndroidSettingsWorld({ device: PROVIDER_SCENARIO_ANDROID_PHONE });

  try {
    const opened = await world.daemon.client().apps.open({ app: 'settings', ...world.selection });
    assert.equal(opened.device?.id, PROVIDER_SCENARIO_ANDROID_PHONE.id);
    const data = assertRpcError(
      await world.daemon.callCommand('telephony', ['call', '5551234'], world.selection),
      'UNSUPPORTED_OPERATION',
      /telephony is not supported on this device/,
    );
    assert.equal((data.details as Record<string, unknown>)?.reason, 'unsupported-device-kind');
    assert.deepEqual(emulatorConsoleCalls(world.adbCalls), []);
  } finally {
    await world.close();
  }
});
