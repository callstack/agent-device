import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'vitest';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { parseReplayScriptDetailed } from '@agent-device/ad-script';
import { assertRpcError } from './assertions.ts';
import { createAndroidSettingsWorld } from './android-world.ts';

const SETTINGS_FOCUS = 'mCurrentFocus=Window{42 u0 com.android.settings/.Settings}\n';
const KEYCODE_SLEEP = '223';
const KEYCODE_WAKEUP = '224';

/**
 * An emulator whose keyguard follows the key events and dismissals it is sent, the way a swipe
 * lock does: KEYCODE_SLEEP raises it and `wm dismiss-keyguard` clears it. `credential` is the
 * foreground user's lock type in `dumpsys lock_settings`.
 */
function keyguardDevice(credential = 'NONE', lockScreenDisabled = false) {
  let showing = false;
  const answer = (stdout: string) => ({ stdout, stderr: '', exitCode: 0 });
  return (args: readonly string[]) => {
    const command = args.join(' ');
    if (command === 'shell dumpsys window') {
      return answer(`${SETTINGS_FOCUS}    isKeyguardShowing=${showing}\n`);
    }
    if (command === `shell input keyevent ${KEYCODE_SLEEP}`) {
      showing = true;
      return answer('');
    }
    if (command === 'shell wm dismiss-keyguard') {
      showing = false;
      return answer('');
    }
    if (command === 'shell dumpsys lock_settings') {
      return answer(
        `User State:\n  User 0\n    CredentialType: ${credential}\n    IsLockScreenDisabled: ${lockScreenDisabled}\n`,
      );
    }
    if (command === 'shell settings get secure lock_screen_lock_after_timeout')
      return answer('null\n');
    return undefined;
  };
}

function lockScreenShellCalls(calls: readonly string[][]): string[] {
  return calls
    .map((call) => call.join(' '))
    .filter(
      (call) =>
        call.startsWith('shell input keyevent') ||
        call === 'shell wm dismiss-keyguard' ||
        call === 'shell dumpsys lock_settings',
    );
}

test('Provider-backed integration Android lock-screen locks and unlocks a swipe keyguard and records both commands', async () => {
  const world = await createAndroidSettingsWorld({ onAdbExec: keyguardDevice() });

  try {
    const client = world.daemon.client();
    await client.apps.open({ app: 'settings', ...world.selection, saveScript: true });
    world.adbCalls.splice(0);

    assert.deepEqual(await client.command.lockScreen({ action: 'lock', ...world.selection }), {
      action: 'lock-screen',
      state: 'locked',
      message: 'Locked the screen',
    });
    assert.deepEqual(await client.command.lockScreen({ action: 'unlock', ...world.selection }), {
      action: 'lock-screen',
      state: 'unlocked',
      message: 'Unlocked the screen',
    });
    assert.deepEqual(lockScreenShellCalls(world.adbCalls), [
      'shell dumpsys lock_settings',
      `shell input keyevent ${KEYCODE_SLEEP}`,
      'shell dumpsys lock_settings',
      `shell input keyevent ${KEYCODE_WAKEUP}`,
      'shell wm dismiss-keyguard',
    ]);

    // A screen already locked is left alone: nothing is sent.
    await client.command.lockScreen({ action: 'lock', ...world.selection });
    world.adbCalls.splice(0);
    await client.command.lockScreen({ action: 'lock', ...world.selection });
    assert.deepEqual(lockScreenShellCalls(world.adbCalls), []);

    await client.command.lockScreen({ action: 'unlock', ...world.selection });
    await client.command.wait({ selector: 'label="Apps"', ...world.selection });
    const published = await client.sessions.saveScript({
      path: path.join(world.tempRoot, 'lock-screen.ad'),
    });
    const actions = parseReplayScriptDetailed(
      fs.readFileSync(published.savedScript, 'utf8'),
    ).actions.filter((action) => action.command === 'lock-screen');
    assert.deepEqual(
      actions.map((action) => action.positionals),
      [['lock'], ['unlock'], ['lock'], ['lock'], ['unlock']],
    );
  } finally {
    await world.close();
  }
});

test('Provider-backed integration Android lock-screen unlock refuses a PIN lock before sending anything', async () => {
  const world = await createAndroidSettingsWorld({ onAdbExec: keyguardDevice('PIN') });

  try {
    await world.daemon.client().apps.open({ app: 'settings', ...world.selection });
    assert.ok(
      await world.daemon.client().command.lockScreen({ action: 'lock', ...world.selection }),
    );
    world.adbCalls.splice(0);

    const data = assertRpcError(
      await world.daemon.callCommand('lock-screen', ['unlock'], world.selection),
      500,
      'UNSUPPORTED_OPERATION',
      /asks for a credential \(pin\)/,
    );
    const details = data.details as Record<string, unknown>;
    assert.equal(details.reason, 'lock-screen-secure');
    assert.equal(details.dispatched, 'no');
    assert.deepEqual(lockScreenShellCalls(world.adbCalls), ['shell dumpsys lock_settings']);
  } finally {
    await world.close();
  }
});

test('Provider-backed integration Android lock-screen refuses an Android TV target before adb', async () => {
  const tv: DeviceInfo = {
    platform: 'android',
    id: 'emulator-5556',
    name: 'Android TV',
    kind: 'emulator',
    target: 'tv',
    booted: true,
  };
  const world = await createAndroidSettingsWorld({ device: tv, onAdbExec: keyguardDevice() });

  try {
    await world.daemon.client().apps.open({ app: 'settings', ...world.selection });
    world.adbCalls.splice(0);
    const data = assertRpcError(
      await world.daemon.callCommand('lock-screen', ['lock'], world.selection),
      500,
      'UNSUPPORTED_OPERATION',
      /lock-screen/,
    );
    assert.equal((data.details as Record<string, unknown>).reason, 'unsupported-platform-leaf');
    assert.deepEqual(lockScreenShellCalls(world.adbCalls), []);
  } finally {
    await world.close();
  }
});

test('Provider-backed integration Android lock-screen lock refuses a screen lock set to None before sending anything', async () => {
  const world = await createAndroidSettingsWorld({ onAdbExec: keyguardDevice('NONE', true) });

  try {
    await world.daemon.client().apps.open({ app: 'settings', ...world.selection });
    world.adbCalls.splice(0);
    const data = assertRpcError(
      await world.daemon.callCommand('lock-screen', ['lock'], world.selection),
      500,
      'UNSUPPORTED_OPERATION',
      /set to None/,
    );
    const details = data.details as Record<string, unknown>;
    assert.equal(details.reason, 'lock-screen-disabled');
    assert.equal(details.dispatched, 'no');
    assert.deepEqual(lockScreenShellCalls(world.adbCalls), ['shell dumpsys lock_settings']);
  } finally {
    await world.close();
  }
});
