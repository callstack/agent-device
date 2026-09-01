import { test } from 'vitest';
import assert from 'node:assert/strict';
import { setAndroidSetting } from '../settings.ts';
import { androidRevokedPermissionWarning } from '../settings-permission.ts';
import { ANDROID_EMULATOR } from './test-utils/device-fixtures.ts';
import { assertRejectsAppError } from './test-utils/app-error.ts';
import { withFakeAdb } from './test-utils/fake-adb.ts';

// #1796. Two invariants decide every case here:
//   * `pm` defaults grant/revoke and the permission-flag operations to UserHandle.USER_SYSTEM,
//     so a bare mutation edits user 0 rather than the foreground user the session app runs as.
//     Proven on a Pixel 7 / API 36 emulator with the foreground user switched to 10: a bare
//     `pm revoke` flipped User 0 to granted=false while User 10 stayed granted=true.
//   * The prior state is read for that same user, and a state we could not read is `unknown` —
//     never `not_granted`, which would claim the app was left alone.
// The fake adb provider installs through the production withAndroidAdbProvider scope, so
// `calls` records device-scoped args without a leading `-s <serial>`.
const CURRENT_USER = 'shell am get-current-user';
const DUMPSYS = 'shell dumpsys package com.example.app';
const MICROPHONE = 'android.permission.RECORD_AUDIO';

/** A dump shaped like the real one: an install-permission section, then per-user blocks. */
function dumpsys(
  users: ReadonlyArray<{ id: number; runtime?: ReadonlyArray<[string, boolean]> }>,
): string {
  return [
    'Packages:',
    '  Package [com.example.app] (abc):',
    '    install permissions:',
    // Install permissions are granted for the package, not per user, and `pm revoke` cannot
    // touch them — a scan that reads `granted=true` anywhere reports these as runtime grants.
    '      android.permission.INTERNET: granted=true',
    `      ${MICROPHONE}: granted=true`,
    ...users.flatMap(({ id, runtime }) => [
      `    User ${id}: ceDataInode=0 installed=true`,
      ...(runtime
        ? [
            '      runtime permissions:',
            ...runtime.map(([permission, granted]) => `        ${permission}: granted=${granted}`),
          ]
        : []),
    ]),
    // A later top-level section repeats `User <id>:` without any runtime block.
    'Queries:',
    '  queryable via interaction:',
    '    User 0:',
  ].join('\n');
}

type FakeAdbReply = string | undefined | { stderr: string; exitCode: number };

function fakeAdb(script: (flat: string) => FakeAdbReply) {
  return (args: string[]) => script(args.join(' '));
}

/** Foreground user `userId`, holding exactly `granted` of the microphone permission. */
function foregroundUser(userId: string, granted: boolean) {
  return fakeAdb((flat) => {
    if (flat === CURRENT_USER) return userId;
    if (flat === DUMPSYS)
      return dumpsys([{ id: Number(userId), runtime: [[MICROPHONE, granted]] }]);
    return undefined;
  });
}

// Exact argv and order, on a device whose foreground user is NOT 0: a response-shape assertion
// passes whether or not the mutation named a user, so these pin the wire instead.
test.each([
  [
    'deny microphone',
    'deny' as const,
    { permissionTarget: 'microphone' } as const,
    [
      ['shell', 'am', 'get-current-user'],
      ['shell', 'dumpsys', 'package', 'com.example.app'],
      ['shell', 'pm', 'revoke', '--user', '10', 'com.example.app', MICROPHONE],
    ],
  ],
  [
    'reset camera',
    'reset' as const,
    { permissionTarget: 'camera' } as const,
    [
      ['shell', 'am', 'get-current-user'],
      ['shell', 'dumpsys', 'package', 'com.example.app'],
      ['shell', 'pm', 'revoke', '--user', '10', 'com.example.app', 'android.permission.CAMERA'],
      // prettier-ignore
      ['shell', 'pm', 'clear-permission-flags', '--user', '10', 'com.example.app', 'android.permission.CAMERA', 'user-set'],
      // prettier-ignore
      ['shell', 'pm', 'clear-permission-flags', '--user', '10', 'com.example.app', 'android.permission.CAMERA', 'user-fixed'],
    ],
  ],
  [
    'reset notifications',
    'reset' as const,
    { permissionTarget: 'notifications' } as const,
    [
      ['shell', 'am', 'get-current-user'],
      ['shell', 'dumpsys', 'package', 'com.example.app'],
      // prettier-ignore
      ['shell', 'pm', 'revoke', '--user', '10', 'com.example.app', 'android.permission.POST_NOTIFICATIONS'],
      // prettier-ignore
      ['shell', 'pm', 'clear-permission-flags', '--user', '10', 'com.example.app', 'android.permission.POST_NOTIFICATIONS', 'user-set'],
      // prettier-ignore
      ['shell', 'pm', 'clear-permission-flags', '--user', '10', 'com.example.app', 'android.permission.POST_NOTIFICATIONS', 'user-fixed'],
      // prettier-ignore
      ['shell', 'appops', 'set', '--user', '10', 'com.example.app', 'POST_NOTIFICATION', 'default'],
    ],
  ],
  [
    'deny notifications',
    'deny' as const,
    { permissionTarget: 'notifications' } as const,
    [
      ['shell', 'am', 'get-current-user'],
      ['shell', 'dumpsys', 'package', 'com.example.app'],
      // prettier-ignore
      ['shell', 'pm', 'revoke', '--user', '10', 'com.example.app', 'android.permission.POST_NOTIFICATIONS'],
      ['shell', 'appops', 'set', '--user', '10', 'com.example.app', 'POST_NOTIFICATION', 'deny'],
    ],
  ],
  [
    'grant microphone',
    'grant' as const,
    { permissionTarget: 'microphone' } as const,
    // No dumpsys: a grant cannot kill the app, so it reads no state.
    [
      ['shell', 'am', 'get-current-user'],
      ['shell', 'pm', 'grant', '--user', '10', 'com.example.app', MICROPHONE],
    ],
  ],
] as const)(
  'setAndroidSetting permission %s addresses the foreground user in every adb call',
  async (_label, action, options, expected) => {
    await withFakeAdb(foregroundUser('10', false), async ({ calls, device }) => {
      await setAndroidSetting(device, 'permission', action, 'com.example.app', options);
      assert.deepEqual(
        calls,
        expected.map((args) => [...args]),
      );
    });
  },
);

// The tri-state, including which user answers it. `unknown` must never be reported as
// `not_granted`, and must still hand over the relaunch guidance.
test.each([
  ['the acting user holds it', foregroundUser('0', true), 'granted'],
  ['the acting user does not', foregroundUser('0', false), 'not_granted'],
  [
    'only another profile holds it',
    fakeAdb((flat) => {
      if (flat === CURRENT_USER) return '0';
      if (flat === DUMPSYS) {
        return dumpsys([
          { id: 0, runtime: [[MICROPHONE, false]] },
          { id: 10, runtime: [[MICROPHONE, true]] },
        ]);
      }
      return undefined;
    }),
    'not_granted',
  ],
  [
    'the acting user is the one that holds it',
    fakeAdb((flat) => {
      if (flat === CURRENT_USER) return '10';
      if (flat === DUMPSYS) {
        return dumpsys([
          { id: 0, runtime: [[MICROPHONE, false]] },
          { id: 10, runtime: [[MICROPHONE, true]] },
        ]);
      }
      return undefined;
    }),
    'granted',
  ],
  [
    'dumpsys fails',
    fakeAdb((flat) => (flat === DUMPSYS ? { stderr: 'error', exitCode: 1 } : '0')),
    'unknown',
  ],
  [
    'dumpsys output is unparseable',
    fakeAdb((flat) => (flat === DUMPSYS ? 'Packages:' : '0')),
    'unknown',
  ],
] as const)(
  'setAndroidSetting permission deny reports %s',
  async (_label, script, priorGrantState) => {
    await withFakeAdb(script, async ({ device }) => {
      const result = await setAndroidSetting(device, 'permission', 'deny', 'com.example.app', {
        permissionTarget: 'microphone',
      });
      const warning = androidRevokedPermissionWarning(
        'com.example.app',
        MICROPHONE,
        priorGrantState,
      );
      assert.deepEqual(result, {
        permission: MICROPHONE,
        priorGrantState,
        ...(warning ? { warnings: [warning] } : {}),
      });
      // not_granted is the only silent state; the other two hand over the same recovery.
      assert.equal(warning === undefined, priorGrantState === 'not_granted');
      if (warning) assert.match(warning, /open com\.example\.app --relaunch/);
    });
  },
);

test('the revoke warning states the platform rule and keeps the consequence conditional', () => {
  // The read proves neither that the app was running nor, for `unknown`, what the state was.
  assert.match(
    androidRevokedPermissionWarning('com.example.app', MICROPHONE, 'granted')!,
    /was granted before this revoke.*if com\.example\.app was running it is no longer/s,
  );
  assert.match(
    androidRevokedPermissionWarning('com.example.app', MICROPHONE, 'unknown')!,
    /could not be read.*may no longer be running/s,
  );
});

// A mutation that cannot name its user is refused, not issued unscoped: `pm` would apply it to
// user 0 and leave a session running as another user untouched, which is the whole defect.
test.each(['grant', 'deny', 'reset'] as const)(
  'setAndroidSetting permission %s refuses to mutate when the acting user cannot be resolved',
  async (action) => {
    await withFakeAdb(
      fakeAdb((flat) =>
        flat === CURRENT_USER ? { stderr: 'cmd: not found', exitCode: 1 } : undefined,
      ),
      async ({ calls, device }) => {
        await assertRejectsAppError(
          () =>
            setAndroidSetting(device, 'permission', action, 'com.example.app', {
              permissionTarget: 'microphone',
            }),
          {
            code: 'COMMAND_FAILED',
            message: /Could not determine which Android user/,
            hint: /am get-current-user/,
          },
        );
        // The load-bearing assertion: the resolution attempt is the ONLY adb call. No pm, no
        // appops, no clear-permission-flags — nothing that could edit user 0's state.
        assert.deepEqual(calls, [['shell', 'am', 'get-current-user']]);
      },
    );
  },
);

// `photos` is the one target whose permission is discovered by probing the device, so its
// SDK-dependent candidate order and the flags that follow the resolved permission are pinned.
test.each([
  ['36', 'reset' as const, 'android.permission.READ_MEDIA_IMAGES'],
  ['32', 'grant' as const, 'android.permission.READ_EXTERNAL_STORAGE'],
] as const)(
  'setAndroidSetting permission photos on SDK %s resolves %s to %s',
  async (sdk, action, permission) => {
    // `reset` maps to `pm revoke`; only `grant` keeps its verb.
    const pmAction = action === 'grant' ? 'grant' : 'revoke';
    await withFakeAdb(
      fakeAdb((flat) => {
        if (flat === 'shell getprop ro.build.version.sdk') return sdk;
        if (flat === CURRENT_USER) return '0';
        if (flat === DUMPSYS) return dumpsys([{ id: 0, runtime: [[permission, true]] }]);
        if (flat.startsWith(`shell pm ${pmAction} --user 0 com.example.app ${permission}`))
          return '';
        return { stderr: `unexpected args: ${flat}`, exitCode: 1 };
      }),
      async ({ calls, device }) => {
        await setAndroidSetting(device, 'permission', action, 'com.example.app', {
          permissionTarget: 'photos',
        });
        const flat = calls.map((args) => args.join(' '));
        assert.ok(flat.includes('shell getprop ro.build.version.sdk'), flat.join('; '));
        assert.ok(
          flat.includes(`shell pm ${pmAction} --user 0 com.example.app ${permission}`),
          flat.join('; '),
        );
        if (action === 'reset') {
          for (const flag of ['user-set', 'user-fixed']) {
            assert.ok(
              flat.includes(
                `shell pm clear-permission-flags --user 0 com.example.app ${permission} ${flag}`,
              ),
              flat.join('; '),
            );
          }
        }
      },
    );
  },
);

test.each([
  [
    'mode outside photos',
    { permissionTarget: 'camera', permissionMode: 'limited' },
    /mode is only supported for photos/i,
  ],
  [
    'an iOS-only target',
    { permissionTarget: 'calendar' },
    /Unsupported permission target on Android/i,
  ],
] as const)('setAndroidSetting permission rejects %s', async (_label, options, message) => {
  await assertRejectsAppError(
    () => setAndroidSetting(ANDROID_EMULATOR, 'permission', 'grant', 'com.example.app', options),
    { code: 'INVALID_ARGS', message },
  );
});

test('setAndroidSetting permission requires an app in session', async () => {
  await assertRejectsAppError(
    () =>
      setAndroidSetting(ANDROID_EMULATOR, 'permission', 'deny', undefined, {
        permissionTarget: 'camera',
      }),
    { code: 'INVALID_ARGS', message: /requires an active app in session/ },
  );
});
