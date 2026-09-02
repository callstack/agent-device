import { test } from 'vitest';
import assert from 'node:assert/strict';
import { setAndroidSetting } from '../settings.ts';
import type { AndroidAirplaneMode } from '../settings-airplane.ts';
import { assertRejectsAppError } from './test-utils/app-error.ts';
import { withFakeAdb, type FakeAdbScript } from './test-utils/fake-adb.ts';

const READ = 'shell cmd connectivity airplane-mode';

/**
 * An Android build whose connectivity service owns airplane mode. `honorWrites: false` models the
 * service accepting the command and leaving the state alone, which is what a silently ineffective
 * airplane-mode path looks like from the outside.
 */
function connectivityService(
  initial: AndroidAirplaneMode,
  options: { honorWrites?: boolean } = {},
): FakeAdbScript {
  let state = initial;
  return (args) => {
    const flat = args.join(' ');
    if (flat === READ) return state;
    if (flat === `${READ} enable` || flat === `${READ} disable`) {
      if (options.honorWrites !== false) state = flat.endsWith('enable') ? 'enabled' : 'disabled';
      return '';
    }
    return { stderr: `unexpected args: ${flat}`, exitCode: 1 };
  };
}

test('setAndroidSetting airplane on enables through connectivity and reports its state', async () => {
  await withFakeAdb(connectivityService('disabled'), async ({ calls, device }) => {
    const result = await setAndroidSetting(device, 'airplane', 'on');
    assert.deepEqual(result, { airplaneMode: 'enabled' });
    assert.deepEqual(
      calls.map((args) => args.join(' ')),
      [READ, `${READ} enable`, READ],
    );
  });
});

test('setAndroidSetting airplane off disables through connectivity and reports its state', async () => {
  await withFakeAdb(connectivityService('enabled'), async ({ calls, device }) => {
    const result = await setAndroidSetting(device, 'airplane', 'off');
    assert.deepEqual(result, { airplaneMode: 'disabled' });
    assert.deepEqual(
      calls.map((args) => args.join(' ')),
      [READ, `${READ} disable`, READ],
    );
  });
});

test('setAndroidSetting airplane reports the state connectivity holds, not the one requested', async () => {
  await withFakeAdb(
    connectivityService('disabled', { honorWrites: false }),
    async ({ calls, device }) => {
      await assertRejectsAppError(() => setAndroidSetting(device, 'airplane', 'on'), {
        code: 'COMMAND_FAILED',
        message: /reads disabled after requesting enabled/,
      });
      assert.deepEqual(
        calls.map((args) => args.join(' ')),
        [READ, `${READ} enable`, READ],
      );
    },
  );
});

test('setAndroidSetting airplane refuses builds without the connectivity command before writing', async () => {
  await withFakeAdb(
    () => ({ stdout: 'Unknown command: airplane-mode', exitCode: 255 }),
    async ({ calls, device }) => {
      await assertRejectsAppError(() => setAndroidSetting(device, 'airplane', 'on'), {
        code: 'UNSUPPORTED_OPERATION',
        message: /no airplane-mode command/,
        hint: /Android 11 \(API 30\)/,
      });
      assert.deepEqual(
        calls.map((args) => args.join(' ')),
        [READ],
      );
    },
  );
});

test('setAndroidSetting airplane refuses unreadable state before writing', async () => {
  await withFakeAdb(
    () => 'Airplane mode: who knows',
    async ({ calls, device }) => {
      await assertRejectsAppError(() => setAndroidSetting(device, 'airplane', 'off'), {
        code: 'COMMAND_FAILED',
        message: /Failed to read Android airplane mode/,
      });
      assert.deepEqual(
        calls.map((args) => args.join(' ')),
        [READ],
      );
    },
  );
});

test('setAndroidSetting airplane keeps a refused read a command failure, not an unsupported build', async () => {
  await withFakeAdb(
    () => ({
      stdout: '',
      stderr: 'java.lang.SecurityException: Permission Denial: not allowed to change airplane mode',
      exitCode: 255,
    }),
    async ({ calls, device }) => {
      await assertRejectsAppError(() => setAndroidSetting(device, 'airplane', 'on'), {
        code: 'COMMAND_FAILED',
        message: /Failed to read Android airplane mode/,
      });
      assert.deepEqual(
        calls.map((args) => args.join(' ')),
        [READ],
      );
    },
  );
});

test('setAndroidSetting airplane fails the change when the state cannot be read back', async () => {
  const service = connectivityService('disabled');
  let changed = false;
  await withFakeAdb(
    (args) => {
      const flat = args.join(' ');
      if (flat === READ && changed)
        return { stdout: 'Unknown command: airplane-mode', exitCode: 255 };
      if (flat === `${READ} enable`) changed = true;
      return service(args);
    },
    async ({ device }) => {
      await assertRejectsAppError(() => setAndroidSetting(device, 'airplane', 'on'), {
        code: 'COMMAND_FAILED',
        message: /Failed to read Android airplane mode after changing it/,
      });
    },
  );
});

test('setAndroidSetting airplane keeps adb transport failures typed as command failures', async () => {
  await withFakeAdb(
    () => ({ stderr: 'error: device offline', exitCode: 1 }),
    async ({ calls, device }) => {
      await assertRejectsAppError(() => setAndroidSetting(device, 'airplane', 'on'), {
        code: 'COMMAND_FAILED',
        message: /Failed to read Android airplane mode/,
        hint: /adb reconnect/,
      });
      assert.deepEqual(
        calls.map((args) => args.join(' ')),
        [READ],
      );
    },
  );
});
