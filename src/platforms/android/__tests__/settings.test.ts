import { test } from 'vitest';
import assert from 'node:assert/strict';
import { setAndroidSetting } from '../settings.ts';
import { ANDROID_EMULATOR } from '../../../__tests__/test-utils/device-fixtures.ts';
import { assertRejectsAppError } from '../../../__tests__/test-utils/app-error.ts';
import { withFakeAdb } from '../../../__tests__/test-utils/fake-adb.ts';

// The fake adb provider installs through the production withAndroidAdbProvider
// scope, so `calls` records device-scoped args without a leading `-s <serial>`.

test('setAndroidSetting appearance toggle flips current mode', async () => {
  await withFakeAdb(
    (args) => (args.join(' ') === 'shell cmd uimode night' ? 'Night mode: yes' : undefined),
    async ({ calls, device }) => {
      await setAndroidSetting(device, 'appearance', 'toggle');
      assert.deepEqual(calls, [
        ['shell', 'cmd', 'uimode', 'night'],
        ['shell', 'cmd', 'uimode', 'night', 'no'],
      ]);
    },
  );
});

test('setAndroidSetting appearance toggle from auto sets dark mode', async () => {
  await withFakeAdb(
    (args) => (args.join(' ') === 'shell cmd uimode night' ? 'Night mode: auto' : undefined),
    async ({ calls, device }) => {
      await setAndroidSetting(device, 'appearance', 'toggle');
      assert.deepEqual(calls[1], ['shell', 'cmd', 'uimode', 'night', 'yes']);
    },
  );
});

test('setAndroidSetting appearance toggle rejects unknown current mode output', async () => {
  await withFakeAdb(
    (args) => (args.join(' ') === 'shell cmd uimode night' ? 'mode unavailable' : undefined),
    async ({ device }) => {
      await assertRejectsAppError(() => setAndroidSetting(device, 'appearance', 'toggle'), {
        code: 'COMMAND_FAILED',
        message: /Unable to determine current Android appearance/,
      });
    },
  );
});

test('setAndroidSetting clear-app-state force stops and clears package data', async () => {
  await withFakeAdb(
    (args) => {
      const flat = args.join(' ');
      if (flat === 'shell am force-stop com.example.app') return '';
      if (flat === 'shell pm clear com.example.app') return 'Success';
      return { stderr: `unexpected args: ${flat}`, exitCode: 1 };
    },
    async ({ calls, device }) => {
      const result = await setAndroidSetting(device, 'clear-app-state', 'clear', 'com.example.app');
      assert.deepEqual(result, { package: 'com.example.app', cleared: true });
      assert.deepEqual(calls, [
        ['shell', 'am', 'force-stop', 'com.example.app'],
        ['shell', 'pm', 'clear', 'com.example.app'],
      ]);
    },
  );
});

test('setAndroidSetting fingerprint retries emulator command when shell cmd fingerprint fails', async () => {
  await withFakeAdb(
    (args) => {
      if (args[0] === 'shell' && args[1] === 'cmd' && args[2] === 'fingerprint') {
        return { stderr: 'fingerprint cmd unavailable', exitCode: 1 };
      }
      if (args.join(' ') === 'emu finger touch 1') return '';
      return { stderr: `unexpected args: ${args.join(' ')}`, exitCode: 1 };
    },
    async ({ calls, device }) => {
      await setAndroidSetting(device, 'fingerprint', 'match');
      const flat = calls.map((args) => args.join(' '));
      assert.ok(flat.includes('shell cmd fingerprint touch 1'), flat.join('; '));
      assert.ok(flat.includes('shell cmd fingerprint finger 1'), flat.join('; '));
      assert.ok(flat.includes('emu finger touch 1'), flat.join('; '));
    },
  );
});

test('setAndroidSetting fingerprint rejects unsupported action', async () => {
  await assertRejectsAppError(() => setAndroidSetting(ANDROID_EMULATOR, 'fingerprint', 'enroll'), {
    code: 'INVALID_ARGS',
    message: /Invalid fingerprint state/,
  });
});

test('setAndroidSetting fingerprint returns COMMAND_FAILED for transport/runtime failures', async () => {
  await withFakeAdb(
    () => ({ stderr: 'error: device offline', exitCode: 1 }),
    async ({ device }) => {
      await assertRejectsAppError(() => setAndroidSetting(device, 'fingerprint', 'match'), {
        code: 'COMMAND_FAILED',
        message: /Failed to simulate Android fingerprint/,
      });
    },
  );
});

test('setAndroidSetting fingerprint does not use adb emu command on physical devices', async () => {
  await withFakeAdb(
    () => ({ stderr: 'unknown command', exitCode: 1 }),
    async ({ calls, device }) => {
      await assertRejectsAppError(() => setAndroidSetting(device, 'fingerprint', 'match'), {
        code: 'UNSUPPORTED_OPERATION',
        message: /Android fingerprint simulation is not supported/,
      });
      const emuCalls = calls.filter((args) => args[0] === 'emu');
      assert.deepEqual(emuCalls, []);
    },
    {
      device: {
        platform: 'android',
        id: 'R5CT11',
        name: 'Pixel Device',
        kind: 'device',
        booted: true,
      },
    },
  );
});
