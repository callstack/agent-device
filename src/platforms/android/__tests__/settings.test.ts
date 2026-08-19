import { test } from 'vitest';
import assert from 'node:assert/strict';
import { androidRevokedPermissionWarning, setAndroidSetting } from '../settings.ts';
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

// #1796: Android kills the app when a permission it holds is revoked. The acting user's prior
// state is read before `pm revoke`; the response reports it as a three-state typed field, because
// a failed or unreadable dump is NOT evidence that the app was left alone.
const CURRENT_USER = 'shell am get-current-user';
const DUMPSYS = 'shell dumpsys package com.example.app';
const REVOKE_MICROPHONE =
  'shell pm revoke --user 0 com.example.app android.permission.RECORD_AUDIO';

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
    '      android.permission.RECORD_AUDIO: granted=true',
    ...users.flatMap(({ id, runtime }) => [
      `    User ${id}: ceDataInode=0 installed=true`,
      ...(runtime
        ? [
            '      runtime permissions:',
            ...runtime.map(
              ([permission, granted]) =>
                `        ${permission}: granted=${granted}, flags=[ USER_SET]`,
            ),
          ]
        : []),
    ]),
    // A later section repeats `User <id>:` without any runtime block.
    'Queries:',
    '  queryable via interaction:',
    '    User 0:',
  ].join('\n');
}

function fakeAdb(
  script: (flat: string) => string | undefined | { stderr: string; exitCode: number },
) {
  return (args: string[]) => script(args.join(' '));
}

test.each(['deny', 'reset'] as const)(
  'setAndroidSetting permission %s reports a granted prior state and warns',
  async (action) => {
    await withFakeAdb(
      fakeAdb((flat) => {
        if (flat === CURRENT_USER) return '0';
        if (flat === DUMPSYS) {
          return dumpsys([{ id: 0, runtime: [['android.permission.RECORD_AUDIO', true]] }]);
        }
        return undefined;
      }),
      async ({ calls, device }) => {
        const result = await setAndroidSetting(device, 'permission', action, 'com.example.app', {
          permissionTarget: 'microphone',
        });
        const flat = calls.map((args) => args.join(' '));
        // The state is read BEFORE the revoke: after it, dumpsys would already say false.
        assert.ok(flat.indexOf(DUMPSYS) < flat.indexOf(REVOKE_MICROPHONE), flat.join('; '));
        assert.deepEqual(result, {
          permission: 'android.permission.RECORD_AUDIO',
          priorGrantState: 'granted',
          warnings: [
            androidRevokedPermissionWarning(
              'com.example.app',
              'android.permission.RECORD_AUDIO',
              'granted',
            ),
          ],
        });
        assert.match(String(result?.warnings), /open com\.example\.app --relaunch/);
        // Conditional on purpose: the read proves neither that the app was running nor that a
        // grant seen elsewhere belonged to the acting user (#1796 review).
        assert.match(String(result?.warnings), /if com\.example\.app was running it is no longer/);
      },
    );
  },
);

test('setAndroidSetting permission deny stays quiet when the acting user did not hold it', async () => {
  await withFakeAdb(
    fakeAdb((flat) => {
      if (flat === CURRENT_USER) return '0';
      if (flat === DUMPSYS) {
        return dumpsys([{ id: 0, runtime: [['android.permission.CAMERA', false]] }]);
      }
      return undefined;
    }),
    async ({ device }) => {
      const result = await setAndroidSetting(device, 'permission', 'deny', 'com.example.app', {
        permissionTarget: 'camera',
      });
      assert.deepEqual(result, {
        permission: 'android.permission.CAMERA',
        priorGrantState: 'not_granted',
      });
    },
  );
});

// The three ways the prior state is genuinely unknown. Each must report `unknown` and still
// hand over the relaunch guidance: asserting `not_granted` here would claim the app survived.
test.each([
  ['dumpsys fails', (flat: string) => (flat === DUMPSYS ? { stderr: 'error', exitCode: 1 } : '0')],
  [
    'dumpsys output is unparseable',
    (flat: string) => (flat === DUMPSYS ? 'Packages:\n  <none>' : '0'),
  ],
  [
    'the acting user cannot be resolved',
    (flat: string) =>
      flat === CURRENT_USER
        ? { stderr: 'cmd: not found', exitCode: 1 }
        : dumpsys([{ id: 0, runtime: [['android.permission.RECORD_AUDIO', true]] }]),
  ],
] as const)(
  'setAndroidSetting permission deny reports unknown (not not_granted) when %s',
  async (_label, script) => {
    await withFakeAdb(
      fakeAdb((flat) => script(flat) as string | { stderr: string; exitCode: number }),
      async ({ device }) => {
        const result = await setAndroidSetting(device, 'permission', 'deny', 'com.example.app', {
          permissionTarget: 'microphone',
        });
        assert.equal(result?.priorGrantState, 'unknown');
        assert.match(String(result?.warnings), /could not be read/);
        assert.match(String(result?.warnings), /open com\.example\.app --relaunch/);
      },
    );
  },
);

// A grant held by another profile is not this revoke's business: `pm revoke` acts on the
// acting user, so user 10's grant must not make user 0's revoke claim the app was killed.
test("setAndroidSetting permission deny reads only the acting user's block", async () => {
  await withFakeAdb(
    fakeAdb((flat) => {
      if (flat === CURRENT_USER) return '0';
      if (flat === DUMPSYS) {
        return dumpsys([
          { id: 0, runtime: [['android.permission.RECORD_AUDIO', false]] },
          { id: 10, runtime: [['android.permission.RECORD_AUDIO', true]] },
        ]);
      }
      return undefined;
    }),
    async ({ device }) => {
      const result = await setAndroidSetting(device, 'permission', 'deny', 'com.example.app', {
        permissionTarget: 'microphone',
      });
      assert.deepEqual(result, {
        permission: 'android.permission.RECORD_AUDIO',
        priorGrantState: 'not_granted',
      });
    },
  );
});

// The read scopes state to the foreground user, so the mutation has to name the same one:
// PackageManagerShellCommand defaults grant/revoke/permission-flag operations to
// UserHandle.USER_SYSTEM, so a bare `pm revoke` on a device whose foreground user is 10 edits
// user 0 and leaves the running app untouched. Proven on a Pixel 7 / API 36 emulator with the
// foreground user switched to 10: bare `pm revoke` flipped User 0 to granted=false while
// User 10 stayed granted=true. These pin the exact argv and order, because a response-shape
// assertion passes either way.
test.each([
  [
    'deny microphone',
    { permissionTarget: 'microphone' } as const,
    'deny' as const,
    [
      ['shell', 'am', 'get-current-user'],
      ['shell', 'dumpsys', 'package', 'com.example.app'],
      [
        'shell',
        'pm',
        'revoke',
        '--user',
        '10',
        'com.example.app',
        'android.permission.RECORD_AUDIO',
      ],
    ],
  ],
  [
    'reset camera',
    { permissionTarget: 'camera' } as const,
    'reset' as const,
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
    { permissionTarget: 'notifications' } as const,
    'reset' as const,
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
] as const)(
  'setAndroidSetting permission %s addresses the foreground user in every adb call',
  async (_label, options, action, expected) => {
    await withFakeAdb(
      fakeAdb((flat) => {
        if (flat === CURRENT_USER) return '10';
        if (flat === DUMPSYS) {
          return dumpsys([
            { id: 0, runtime: [['android.permission.RECORD_AUDIO', true]] },
            { id: 10, runtime: [['android.permission.RECORD_AUDIO', false]] },
          ]);
        }
        return undefined;
      }),
      async ({ calls, device }) => {
        await setAndroidSetting(device, 'permission', action, 'com.example.app', options);
        assert.deepEqual(
          calls,
          expected.map((args) => [...args]),
        );
      },
    );
  },
);

test('setAndroidSetting permission grant addresses the foreground user too', async () => {
  await withFakeAdb(
    fakeAdb((flat) => (flat === CURRENT_USER ? '10' : undefined)),
    async ({ calls, device }) => {
      await setAndroidSetting(device, 'permission', 'grant', 'com.example.app', {
        permissionTarget: 'microphone',
      });
      assert.deepEqual(calls, [
        ['shell', 'am', 'get-current-user'],
        // prettier-ignore
        ['shell', 'pm', 'grant', '--user', '10', 'com.example.app', 'android.permission.RECORD_AUDIO'],
      ]);
    },
  );
});

// The read and the mutation must agree about WHICH user, not merely both name one: with the
// foreground user 10 holding the permission and user 0 not, the response must report granted.
test('setAndroidSetting permission deny reads the same user it revokes', async () => {
  await withFakeAdb(
    fakeAdb((flat) => {
      if (flat === CURRENT_USER) return '10';
      if (flat === DUMPSYS) {
        return dumpsys([
          { id: 0, runtime: [['android.permission.RECORD_AUDIO', false]] },
          { id: 10, runtime: [['android.permission.RECORD_AUDIO', true]] },
        ]);
      }
      return undefined;
    }),
    async ({ device }) => {
      const result = await setAndroidSetting(device, 'permission', 'deny', 'com.example.app', {
        permissionTarget: 'microphone',
      });
      assert.equal(result?.priorGrantState, 'granted');
      assert.match(String(result?.warnings), /open com\.example\.app --relaunch/);
    },
  );
});

// No resolvable user means no way to address one: the mutation keeps the platform default and
// the state is reported unknown rather than read from a user the revoke may not have touched.
test('setAndroidSetting permission deny omits --user when the foreground user is unknown', async () => {
  await withFakeAdb(
    fakeAdb((flat) =>
      flat === CURRENT_USER ? { stderr: 'cmd: not found', exitCode: 1 } : undefined,
    ),
    async ({ calls, device }) => {
      const result = await setAndroidSetting(device, 'permission', 'deny', 'com.example.app', {
        permissionTarget: 'microphone',
      });
      assert.deepEqual(calls, [
        ['shell', 'am', 'get-current-user'],
        ['shell', 'pm', 'revoke', 'com.example.app', 'android.permission.RECORD_AUDIO'],
      ]);
      assert.equal(result?.priorGrantState, 'unknown');
    },
  );
});

test('setAndroidSetting permission grant does not read grant state', async () => {
  await withFakeAdb(
    fakeAdb((flat) => (flat === CURRENT_USER ? '0' : undefined)),
    async ({ calls, device }) => {
      const result = await setAndroidSetting(device, 'permission', 'grant', 'com.example.app', {
        permissionTarget: 'camera',
      });
      assert.equal(result, undefined);
      // The user is resolved for the mutation, but no state is read: grant cannot kill the app.
      assert.deepEqual(calls, [
        ['shell', 'am', 'get-current-user'],
        ['shell', 'pm', 'grant', '--user', '0', 'com.example.app', 'android.permission.CAMERA'],
      ]);
    },
  );
});

test('setAndroidSetting permission reset notifications reports the POST_NOTIFICATIONS state', async () => {
  await withFakeAdb(
    fakeAdb((flat) => {
      if (flat === CURRENT_USER) return '0';
      if (flat === DUMPSYS) {
        return dumpsys([{ id: 0, runtime: [['android.permission.POST_NOTIFICATIONS', true]] }]);
      }
      return undefined;
    }),
    async ({ device }) => {
      const result = await setAndroidSetting(device, 'permission', 'reset', 'com.example.app', {
        permissionTarget: 'notifications',
      });
      assert.equal(result?.priorGrantState, 'granted');
      assert.equal(Array.isArray(result?.warnings), true);
    },
  );
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
