import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'vitest';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { parseReplayScriptDetailed } from '@agent-device/ad-script';
import { assertRpcError } from './assertions.ts';
import { createAndroidSettingsWorld } from './android-world.ts';

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

const REST = '0:9.776:0.812';

function emulatorConsoleCalls(calls: readonly string[][]): string[] {
  return calls
    .map((call) => call.slice(call.indexOf('emu')))
    .filter((call) => call[0] === 'emu')
    .map((call) => call.slice(1).join(' '));
}

test('Provider-backed integration Android emulator shake swings the console accelerometer, restores it and records the command', async () => {
  const world = await createAndroidSettingsWorld({
    device: PROVIDER_SCENARIO_ANDROID_EMULATOR,
    onAdbExec: (args) => {
      if (args[0] !== 'emu') return undefined;
      const stdout = args[2] === 'get' ? `acceleration = ${REST}\nOK\n` : 'OK\n';
      return { stdout, stderr: '', exitCode: 0 };
    },
  });

  try {
    const client = world.daemon.client();
    await client.apps.open({ app: 'settings', ...world.selection, saveScript: true });

    const result = await client.command.shake(world.selection);

    assert.deepEqual(result, { action: 'shake', message: 'Shook the device' });
    assert.deepEqual(emulatorConsoleCalls(world.adbCalls), [
      'sensor get acceleration',
      ...Array.from(
        { length: 10 },
        (_, swing) => `sensor set acceleration ${swing % 2 === 0 ? '20' : '-20'}:9.776:0.812`,
      ),
      `sensor set acceleration ${REST}`,
    ]);

    await client.command.wait({ selector: 'label="Apps"', ...world.selection });
    const published = await client.sessions.saveScript({
      path: path.join(world.tempRoot, 'shake.ad'),
    });
    const actions = parseReplayScriptDetailed(
      fs.readFileSync(published.savedScript, 'utf8'),
    ).actions;
    assert.deepEqual(
      actions.filter((action) => action.command === 'shake').map((action) => action.command),
      ['shake'],
    );
  } finally {
    await world.close();
  }
});

test('Provider-backed integration Android shake reports a console refusal and still restores the rest reading', async () => {
  const world = await createAndroidSettingsWorld({
    onAdbExec: (args) => {
      if (args[0] !== 'emu') return undefined;
      if (args[2] === 'get')
        return { stdout: `acceleration = ${REST}\nOK\n`, stderr: '', exitCode: 0 };
      return args[4] === REST
        ? { stdout: 'OK\n', stderr: '', exitCode: 0 }
        : { stdout: 'KO: sensor disabled\n', stderr: '', exitCode: 0 };
    },
  });

  try {
    await world.daemon.client().apps.open({ app: 'settings', ...world.selection });
    const data = assertRpcError(
      await world.daemon.callCommand('shake', [], world.selection),
      500,
      'COMMAND_FAILED',
      /refused the shake/,
    );
    assert.equal((data.details as Record<string, unknown>)?.reason, 'shake-console-refused');
    assert.deepEqual(emulatorConsoleCalls(world.adbCalls), [
      'sensor get acceleration',
      'sensor set acceleration 20:9.776:0.812',
      `sensor set acceleration ${REST}`,
    ]);
  } finally {
    await world.close();
  }
});

test('Provider-backed integration Android shake refuses a physical device before the emulator console', async () => {
  const world = await createAndroidSettingsWorld({ device: PROVIDER_SCENARIO_ANDROID_PHONE });

  try {
    await world.daemon.client().apps.open({ app: 'settings', ...world.selection });
    const data = assertRpcError(
      await world.daemon.callCommand('shake', [], world.selection),
      500,
      'UNSUPPORTED_OPERATION',
      /shake is not supported on this device/,
    );
    assert.equal((data.details as Record<string, unknown>)?.reason, 'unsupported-device-kind');
    assert.deepEqual(emulatorConsoleCalls(world.adbCalls), []);
  } finally {
    await world.close();
  }
});
