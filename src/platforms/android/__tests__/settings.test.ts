import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  androidRevokedGrantedPermissionWarning,
  parseAndroidGrantedRuntimePermissions,
  setAndroidSetting,
} from '../settings.ts';
import {
  ANDROID_EMULATOR,
  assertRejectsAppError,
  withFakeAdb,
} from '../../../__tests__/test-utils/index.ts';

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

test('setAndroidSetting permission deny notifications revokes runtime permission and appops', async () => {
  await withFakeAdb(
    () => undefined,
    async ({ calls, device }) => {
      await setAndroidSetting(device, 'permission', 'deny', 'com.example.app', {
        permissionTarget: 'notifications',
      });
      const flat = calls.map((args) => args.join(' '));
      assert.ok(
        flat.includes('shell pm revoke com.example.app android.permission.POST_NOTIFICATIONS'),
        flat.join('; '),
      );
      assert.ok(
        flat.includes('shell appops set com.example.app POST_NOTIFICATION deny'),
        flat.join('; '),
      );
    },
  );
});

test('setAndroidSetting permission reset notifications clears permission flags for reprompt', async () => {
  await withFakeAdb(
    () => undefined,
    async ({ calls, device }) => {
      await setAndroidSetting(device, 'permission', 'reset', 'com.example.app', {
        permissionTarget: 'notifications',
      });
      const flat = calls.map((args) => args.join(' '));
      assert.ok(
        flat.includes('shell pm revoke com.example.app android.permission.POST_NOTIFICATIONS'),
        flat.join('; '),
      );
      assert.ok(
        flat.includes(
          'shell pm clear-permission-flags com.example.app android.permission.POST_NOTIFICATIONS user-set',
        ),
        flat.join('; '),
      );
      assert.ok(
        flat.includes(
          'shell pm clear-permission-flags com.example.app android.permission.POST_NOTIFICATIONS user-fixed',
        ),
        flat.join('; '),
      );
      assert.ok(
        flat.includes('shell appops set com.example.app POST_NOTIFICATION default'),
        flat.join('; '),
      );
    },
  );
});

// #1796: Android kills the app when a permission it holds is revoked. The prior grant state is
// read before `pm revoke`, and a granted -> revoked transition surfaces as a warning + typed field.
const DUMPSYS_MICROPHONE_GRANTED = [
  'Packages:',
  '  Package [com.example.app] (abc):',
  '    User 0: ceDataInode=0 installed=true',
  '      runtime permissions:',
  '        android.permission.RECORD_AUDIO: granted=true, flags=[ USER_SET|USER_SENSITIVE_WHEN_GRANTED]',
  '        android.permission.CAMERA: granted=false, flags=[ USER_SENSITIVE_WHEN_GRANTED]',
].join('\n');

test.each(['deny', 'reset'] as const)(
  'setAndroidSetting permission %s warns that revoking a granted permission killed the app',
  async (action) => {
    await withFakeAdb(
      (args) =>
        args.join(' ') === 'shell dumpsys package com.example.app'
          ? DUMPSYS_MICROPHONE_GRANTED
          : undefined,
      async ({ calls, device }) => {
        const result = await setAndroidSetting(device, 'permission', action, 'com.example.app', {
          permissionTarget: 'microphone',
        });
        const flat = calls.map((args) => args.join(' '));
        // The state is read BEFORE the revoke: after it, dumpsys would already say false.
        assert.ok(
          flat.indexOf('shell dumpsys package com.example.app') <
            flat.indexOf('shell pm revoke com.example.app android.permission.RECORD_AUDIO'),
          flat.join('; '),
        );
        assert.deepEqual(result, {
          permission: 'android.permission.RECORD_AUDIO',
          wasGranted: true,
          warnings: [
            androidRevokedGrantedPermissionWarning(
              'com.example.app',
              'android.permission.RECORD_AUDIO',
            ),
          ],
        });
        assert.match(String(result?.warnings), /open com\.example\.app --relaunch/);
        // The warning states the platform rule and keeps the consequence conditional: the
        // prior-grant read proves neither that the app was running nor that the grant was
        // the current user's (#1796 review).
        assert.match(String(result?.warnings), /if com\.example\.app was running it is no longer/);
      },
    );
  },
);

test('setAndroidSetting permission deny stays quiet when the permission was not granted', async () => {
  await withFakeAdb(
    (args) =>
      args.join(' ') === 'shell dumpsys package com.example.app'
        ? DUMPSYS_MICROPHONE_GRANTED
        : undefined,
    async ({ device }) => {
      const result = await setAndroidSetting(device, 'permission', 'deny', 'com.example.app', {
        permissionTarget: 'camera',
      });
      assert.deepEqual(result, { permission: 'android.permission.CAMERA', wasGranted: false });
    },
  );
});

test('setAndroidSetting permission grant does not read grant state', async () => {
  await withFakeAdb(
    () => undefined,
    async ({ calls, device }) => {
      const result = await setAndroidSetting(device, 'permission', 'grant', 'com.example.app', {
        permissionTarget: 'camera',
      });
      assert.equal(result, undefined);
      assert.deepEqual(calls, [
        ['shell', 'pm', 'grant', 'com.example.app', 'android.permission.CAMERA'],
      ]);
    },
  );
});

test('setAndroidSetting permission reset notifications warns when POST_NOTIFICATIONS was granted', async () => {
  await withFakeAdb(
    (args) =>
      args.join(' ') === 'shell dumpsys package com.example.app'
        ? '      runtime permissions:\n        android.permission.POST_NOTIFICATIONS: granted=true, flags=[ USER_SET]'
        : undefined,
    async ({ device }) => {
      const result = await setAndroidSetting(device, 'permission', 'reset', 'com.example.app', {
        permissionTarget: 'notifications',
      });
      assert.equal(result?.wasGranted, true);
      assert.equal(Array.isArray(result?.warnings), true);
    },
  );
});

test('parseAndroidGrantedRuntimePermissions reads only granted=true runtime permissions', () => {
  assert.deepEqual(
    [...parseAndroidGrantedRuntimePermissions(DUMPSYS_MICROPHONE_GRANTED)],
    ['android.permission.RECORD_AUDIO'],
  );
  assert.deepEqual([...parseAndroidGrantedRuntimePermissions('')], []);
});

test('setAndroidSetting permission reset camera clears permission flags for reprompt', async () => {
  await withFakeAdb(
    () => undefined,
    async ({ calls, device }) => {
      await setAndroidSetting(device, 'permission', 'reset', 'com.example.app', {
        permissionTarget: 'camera',
      });
      const flat = calls.map((args) => args.join(' '));
      assert.ok(
        flat.includes('shell pm revoke com.example.app android.permission.CAMERA'),
        flat.join('; '),
      );
      assert.ok(
        flat.includes(
          'shell pm clear-permission-flags com.example.app android.permission.CAMERA user-set',
        ),
        flat.join('; '),
      );
      assert.ok(
        flat.includes(
          'shell pm clear-permission-flags com.example.app android.permission.CAMERA user-fixed',
        ),
        flat.join('; '),
      );
    },
  );
});

test('setAndroidSetting permission reset photos clears flags for the resolved permission', async () => {
  await withFakeAdb(
    (args) => (args.join(' ') === 'shell getprop ro.build.version.sdk' ? '36' : undefined),
    async ({ calls, device }) => {
      await setAndroidSetting(device, 'permission', 'reset', 'com.example.app', {
        permissionTarget: 'photos',
      });
      const flat = calls.map((args) => args.join(' '));
      assert.ok(
        flat.includes('shell pm revoke com.example.app android.permission.READ_MEDIA_IMAGES'),
        flat.join('; '),
      );
      assert.ok(
        flat.includes(
          'shell pm clear-permission-flags com.example.app android.permission.READ_MEDIA_IMAGES user-set',
        ),
        flat.join('; '),
      );
      assert.ok(
        flat.includes(
          'shell pm clear-permission-flags com.example.app android.permission.READ_MEDIA_IMAGES user-fixed',
        ),
        flat.join('; '),
      );
    },
  );
});

test('setAndroidSetting permission rejects mode argument', async () => {
  await assertRejectsAppError(
    () =>
      setAndroidSetting(ANDROID_EMULATOR, 'permission', 'grant', 'com.example.app', {
        permissionTarget: 'camera',
        permissionMode: 'limited',
      }),
    { code: 'INVALID_ARGS', message: /mode is only supported for photos/i },
  );
});

test('setAndroidSetting permission rejects iOS-only targets with Android-specific guidance', async () => {
  await assertRejectsAppError(
    () =>
      setAndroidSetting(ANDROID_EMULATOR, 'permission', 'grant', 'com.example.app', {
        permissionTarget: 'calendar',
      }),
    { code: 'INVALID_ARGS', message: /Unsupported permission target on Android/i },
  );
});

test('setAndroidSetting permission grant photos falls back to legacy permission on older SDK', async () => {
  await withFakeAdb(
    (args) => {
      const flat = args.join(' ');
      if (flat === 'shell getprop ro.build.version.sdk') return '32';
      if (flat === 'shell pm grant com.example.app android.permission.READ_EXTERNAL_STORAGE') {
        return '';
      }
      return { stderr: `unexpected args: ${flat}`, exitCode: 1 };
    },
    async ({ calls, device }) => {
      await setAndroidSetting(device, 'permission', 'grant', 'com.example.app', {
        permissionTarget: 'photos',
      });
      const flat = calls.map((args) => args.join(' '));
      assert.ok(flat.includes('shell getprop ro.build.version.sdk'), flat.join('; '));
      assert.ok(
        flat.includes('shell pm grant com.example.app android.permission.READ_EXTERNAL_STORAGE'),
        flat.join('; '),
      );
    },
  );
});
