import { test } from 'vitest';
import assert from 'node:assert/strict';
import { closeAndroidApp, openAndroidApp } from '../app-lifecycle.ts';
import { withAndroidAdbProvider } from '../adb-executor.ts';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import {
  assertRejectsAppError,
  ANDROID_EMULATOR,
  withFakeAdb,
  type FakeAdbResponse,
} from '../../../__tests__/test-utils/index.ts';

test('openAndroidApp rejects activity override for deep link URLs', async () => {
  const device: DeviceInfo = {
    platform: 'android',
    id: 'emulator-5554',
    name: 'Pixel',
    kind: 'emulator',
    booted: true,
  };

  await assertRejectsAppError(
    () => openAndroidApp(device, '  https://example.com/path  ', '.MainActivity'),
    { code: 'INVALID_ARGS' },
  );
});

test('closeAndroidApp waits until package is no longer foreground', async () => {
  const device: DeviceInfo = {
    platform: 'android',
    id: 'emulator-5554',
    name: 'Pixel',
    kind: 'emulator',
    booted: true,
  };
  const calls: string[][] = [];
  let focusPolls = 0;

  await withAndroidAdbProvider(
    {
      exec: async (args) => {
        calls.push(args);
        if (args.join(' ') === 'shell dumpsys window windows') {
          focusPolls += 1;
          return {
            stdout:
              focusPolls === 1
                ? 'mCurrentFocus=Window{42 u0 com.example.app/.MainActivity}\n'
                : 'mCurrentFocus=Window{43 u0 com.android.launcher/.Launcher}\n',
            stderr: '',
            exitCode: 0,
          };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      },
      reverse: {
        ensure: async () => {},
        remove: async () => {},
        removeAllOwned: async () => {},
      },
    },
    { serial: 'emulator-5554' },
    async () => await closeAndroidApp(device, 'com.example.app'),
  );

  assert.deepEqual(calls, [
    ['shell', 'am', 'force-stop', 'com.example.app'],
    ['shell', 'dumpsys', 'window', 'windows'],
    ['shell', 'dumpsys', 'window', 'windows'],
    ['shell', 'pidof', 'com.example.app'],
    ['shell', 'pidof', 'com.example.app'],
  ]);
});

test('closeAndroidApp returns after force-stop when package is already not foreground', async () => {
  const device: DeviceInfo = {
    platform: 'android',
    id: 'emulator-5554',
    name: 'Pixel',
    kind: 'emulator',
    booted: true,
  };
  const calls: string[][] = [];

  await withAndroidAdbProvider(
    {
      exec: async (args) => {
        calls.push(args);
        if (args.join(' ') === 'shell dumpsys window windows') {
          return {
            stdout: 'mCurrentFocus=Window{43 u0 com.android.launcher/.Launcher}\n',
            stderr: '',
            exitCode: 0,
          };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      },
      reverse: {
        ensure: async () => {},
        remove: async () => {},
        removeAllOwned: async () => {},
      },
    },
    { serial: 'emulator-5554' },
    async () => await closeAndroidApp(device, 'com.example.app'),
  );

  assert.deepEqual(calls, [
    ['shell', 'am', 'force-stop', 'com.example.app'],
    ['shell', 'dumpsys', 'window', 'windows'],
    ['shell', 'pidof', 'com.example.app'],
    ['shell', 'pidof', 'com.example.app'],
  ]);
});

test('closeAndroidApp waits until package process exits after force-stop', async () => {
  const device: DeviceInfo = {
    platform: 'android',
    id: 'emulator-5554',
    name: 'Pixel',
    kind: 'emulator',
    booted: true,
  };
  const calls: string[][] = [];
  let processPolls = 0;

  await withAndroidAdbProvider(
    {
      exec: async (args) => {
        calls.push(args);
        if (args.join(' ') === 'shell dumpsys window windows') {
          return {
            stdout: 'mCurrentFocus=Window{43 u0 com.android.launcher/.Launcher}\n',
            stderr: '',
            exitCode: 0,
          };
        }
        if (args.join(' ') === 'shell pidof com.example.app') {
          processPolls += 1;
          return {
            stdout: processPolls === 1 ? '12345\n' : '',
            stderr: '',
            exitCode: processPolls === 1 ? 0 : 1,
          };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      },
      reverse: {
        ensure: async () => {},
        remove: async () => {},
        removeAllOwned: async () => {},
      },
    },
    { serial: 'emulator-5554' },
    async () => await closeAndroidApp(device, 'com.example.app'),
  );

  assert.deepEqual(calls, [
    ['shell', 'am', 'force-stop', 'com.example.app'],
    ['shell', 'dumpsys', 'window', 'windows'],
    ['shell', 'pidof', 'com.example.app'],
    ['shell', 'pidof', 'com.example.app'],
    ['shell', 'pidof', 'com.example.app'],
  ]);
});

test('openAndroidApp ensures Android reverse before localhost deep link launch', async () => {
  const device: DeviceInfo = {
    platform: 'android',
    id: 'emulator-5554',
    name: 'Pixel',
    kind: 'emulator',
    booted: true,
  };
  const calls: Array<
    { kind: 'exec'; args: string[] } | { kind: 'reverse'; local: string; remote: string }
  > = [];

  await withAndroidAdbProvider(
    {
      exec: async (args) => {
        calls.push({ kind: 'exec', args });
        return { stdout: '', stderr: '', exitCode: 0 };
      },
      reverse: {
        ensure: async (mapping) => {
          calls.push({ kind: 'reverse', local: mapping.local, remote: mapping.remote });
        },
        remove: async () => {},
        removeAllOwned: async () => {},
      },
    },
    { serial: 'emulator-5554' },
    async () => await openAndroidApp(device, 'exp://127.0.0.1:8083'),
  );

  assert.deepEqual(calls, [
    { kind: 'reverse', local: 'tcp:8083', remote: 'tcp:8083' },
    {
      kind: 'exec',
      args: [
        'shell',
        'am',
        'start',
        '-W',
        '-a',
        'android.intent.action.VIEW',
        '-d',
        'exp://127.0.0.1:8083',
      ],
    },
  ]);
});

test('openAndroidApp ensures Android reverse before localhost app-bound deep link launch', async () => {
  const device: DeviceInfo = {
    platform: 'android',
    id: 'emulator-5554',
    name: 'Pixel',
    kind: 'emulator',
    booted: true,
  };
  const calls: Array<
    { kind: 'exec'; args: string[] } | { kind: 'reverse'; local: string; remote: string }
  > = [];

  await withAndroidAdbProvider(
    {
      exec: async (args) => {
        calls.push({ kind: 'exec', args });
        return {
          stdout: args.join(' ') === 'shell pm list packages' ? 'package:com.example.app\n' : '',
          stderr: '',
          exitCode: 0,
        };
      },
      reverse: {
        ensure: async (mapping) => {
          calls.push({ kind: 'reverse', local: mapping.local, remote: mapping.remote });
        },
        remove: async () => {},
        removeAllOwned: async () => {},
      },
    },
    { serial: 'emulator-5554' },
    async () =>
      await openAndroidApp(device, 'com.example.app', { url: 'http://localhost:8081/status' }),
  );

  assert.deepEqual(calls, [
    { kind: 'reverse', local: 'tcp:8081', remote: 'tcp:8081' },
    {
      kind: 'exec',
      args: [
        'shell',
        'am',
        'start',
        '-W',
        '-a',
        'android.intent.action.VIEW',
        '-d',
        'http://localhost:8081/status',
        '-p',
        'com.example.app',
      ],
    },
  ]);
});

test('openAndroidApp ensures Android reverse before IPv6 localhost deep link launch', async () => {
  const device: DeviceInfo = {
    platform: 'android',
    id: 'emulator-5554',
    name: 'Pixel',
    kind: 'emulator',
    booted: true,
  };
  const calls: Array<
    { kind: 'exec'; args: string[] } | { kind: 'reverse'; local: string; remote: string }
  > = [];

  await withAndroidAdbProvider(
    {
      exec: async (args) => {
        calls.push({ kind: 'exec', args });
        return { stdout: '', stderr: '', exitCode: 0 };
      },
      reverse: {
        ensure: async (mapping) => {
          calls.push({ kind: 'reverse', local: mapping.local, remote: mapping.remote });
        },
        remove: async () => {},
        removeAllOwned: async () => {},
      },
    },
    { serial: 'emulator-5554' },
    async () => await openAndroidApp(device, 'http://[::1]:8081/status'),
  );

  assert.deepEqual(calls, [
    { kind: 'reverse', local: 'tcp:8081', remote: 'tcp:8081' },
    {
      kind: 'exec',
      args: [
        'shell',
        'am',
        'start',
        '-W',
        '-a',
        'android.intent.action.VIEW',
        '-d',
        "'http://[::1]:8081/status'",
      ],
    },
  ]);
});

test('openAndroidApp leaves localhost deep links without a port unchanged', async () => {
  const device: DeviceInfo = {
    platform: 'android',
    id: 'emulator-5554',
    name: 'Pixel',
    kind: 'emulator',
    booted: true,
  };
  const calls: string[][] = [];

  await withAndroidAdbProvider(
    {
      exec: async (args) => {
        calls.push(args);
        return { stdout: '', stderr: '', exitCode: 0 };
      },
      reverse: {
        ensure: async () => {
          throw new Error('reverse should not run without a URL port');
        },
        remove: async () => {},
        removeAllOwned: async () => {},
      },
    },
    { serial: 'emulator-5554' },
    async () => await openAndroidApp(device, 'http://localhost/path'),
  );

  assert.deepEqual(calls, [
    [
      'shell',
      'am',
      'start',
      '-W',
      '-a',
      'android.intent.action.VIEW',
      '-d',
      'http://localhost/path',
    ],
  ]);
});

test('openAndroidApp leaves non-localhost deep links unchanged', async () => {
  const device: DeviceInfo = {
    platform: 'android',
    id: 'emulator-5554',
    name: 'Pixel',
    kind: 'emulator',
    booted: true,
  };
  const calls: string[][] = [];

  await withAndroidAdbProvider(
    {
      exec: async (args) => {
        calls.push(args);
        return { stdout: '', stderr: '', exitCode: 0 };
      },
      reverse: {
        ensure: async () => {
          throw new Error('reverse should not run for remote URLs');
        },
        remove: async () => {},
        removeAllOwned: async () => {},
      },
    },
    { serial: 'emulator-5554' },
    async () => await openAndroidApp(device, 'https://example.com:8083/path'),
  );

  assert.deepEqual(calls, [
    [
      'shell',
      'am',
      'start',
      '-W',
      '-a',
      'android.intent.action.VIEW',
      '-d',
      'https://example.com:8083/path',
    ],
  ]);
});

test('openAndroidApp reports localhost reverse failures with port context', async () => {
  const device: DeviceInfo = {
    platform: 'android',
    id: 'emulator-5554',
    name: 'Pixel',
    kind: 'emulator',
    booted: true,
  };

  await withAndroidAdbProvider(
    {
      exec: async (args) => {
        throw new Error(`unexpected adb exec: ${args.join(' ')}`);
      },
      reverse: {
        ensure: async () => {
          throw new Error('bridge unavailable');
        },
        remove: async () => {},
        removeAllOwned: async () => {},
      },
    },
    { serial: 'emulator-5554' },
    async () => {
      await assert.rejects(
        () => openAndroidApp(device, 'http://localhost:8081'),
        (error: unknown) => {
          assert.equal(error instanceof AppError, true);
          assert.equal((error as AppError).code, 'COMMAND_FAILED');
          assert.match((error as Error).message, /tcp:8081/);
          assert.match((error as Error).message, /reverse/i);
          return true;
        },
      );
    },
  );
});

test('openAndroidApp binds deep link URLs to the requested package', async () => {
  await withFakeAdb(androidOpenFakeAdb, async ({ calls, device }) => {
    await openAndroidApp(device, 'com.example.app', { url: 'example://bottom-tabs' });
    assert.deepEqual(calls, [
      [
        'shell',
        'am',
        'start',
        '-W',
        '-a',
        'android.intent.action.VIEW',
        '-d',
        'example://bottom-tabs',
        '-p',
        'com.example.app',
      ],
    ]);
  });
});

test('openAndroidApp default launch uses -p package flag', async () => {
  await withFakeAdb(androidOpenFakeAdb, async ({ calls, device }) => {
    await openAndroidApp(device, 'com.example.app');
    assert.deepEqual(calls, [
      [
        'shell',
        'am',
        'start',
        '-W',
        '-a',
        'android.intent.action.MAIN',
        '-c',
        'android.intent.category.DEFAULT',
        '-c',
        'android.intent.category.LAUNCHER',
        '-p',
        'com.example.app',
      ],
    ]);
  });
});

test('openAndroidApp appends launchArgs to am start when launching by package', async () => {
  await withFakeAdb(androidOpenFakeAdb, async ({ calls, device }) => {
    await openAndroidApp(device, 'com.example.app', {
      launchArgs: ['--es', 'screen', 'home', '--ez', 'fresh', 'true'],
    });
    assert.deepEqual(calls, [
      [
        'shell',
        'am',
        'start',
        '-W',
        '-a',
        'android.intent.action.MAIN',
        '-c',
        'android.intent.category.DEFAULT',
        '-c',
        'android.intent.category.LAUNCHER',
        '-p',
        'com.example.app',
        '--es',
        'screen',
        'home',
        '--ez',
        'fresh',
        'true',
      ],
    ]);
  });
});

test('openAndroidApp appends launchArgs to am start when activity override is set', async () => {
  await withFakeAdb(androidOpenFakeAdb, async ({ calls, device }) => {
    await openAndroidApp(device, 'com.example.app', {
      activity: '.MainActivity',
      launchArgs: ['--es', 'mode', 'debug'],
    });
    assert.deepEqual(calls, [
      [
        'shell',
        'am',
        'start',
        '-W',
        '-a',
        'android.intent.action.MAIN',
        '-c',
        'android.intent.category.DEFAULT',
        '-c',
        'android.intent.category.LAUNCHER',
        '-n',
        'com.example.app/.MainActivity',
        '--es',
        'mode',
        'debug',
      ],
    ]);
  });
});

test('openAndroidApp appends launchArgs to am start for deep link URL opens', async () => {
  await withFakeAdb(androidOpenFakeAdb, async ({ calls, device }) => {
    await openAndroidApp(device, 'myapp://item/42', {
      launchArgs: ['--es', 'ref', 'campaign'],
    });
    assert.deepEqual(calls, [
      [
        'shell',
        'am',
        'start',
        '-W',
        '-a',
        'android.intent.action.VIEW',
        '-d',
        'myapp://item/42',
        '--es',
        'ref',
        'campaign',
      ],
    ]);
  });
});

test('openAndroidApp quotes deep link URL shell characters', async () => {
  await withFakeAdb(androidOpenFakeAdb, async ({ calls, device }) => {
    await openAndroidApp(device, 'myapp://item/42?event=cold.start&source=smoke');
    assert.deepEqual(calls, [
      [
        'shell',
        'am',
        'start',
        '-W',
        '-a',
        'android.intent.action.VIEW',
        '-d',
        "'myapp://item/42?event=cold.start&source=smoke'",
      ],
    ]);
  });
});

test('openAndroidApp appends launchArgs to am start for app-bound URL opens', async () => {
  await withFakeAdb(androidOpenFakeAdb, async ({ calls, device }) => {
    await openAndroidApp(device, 'com.example.app', {
      url: 'https://example.com/promo',
      launchArgs: ['--es', 'ref', 'campaign'],
    });
    assert.deepEqual(calls, [
      [
        'shell',
        'am',
        'start',
        '-W',
        '-a',
        'android.intent.action.VIEW',
        '-d',
        'https://example.com/promo',
        '-p',
        'com.example.app',
        '--es',
        'ref',
        'campaign',
      ],
    ]);
  });
});

test('openAndroidApp shell-quotes launchArgs containing JSON or shell metacharacters', async () => {
  await withFakeAdb(androidOpenFakeAdb, async ({ calls, device }) => {
    // Value contains characters the device shell would otherwise re-interpret:
    // `#` (comment), `;` (statement separator), `&` (background), `*` (glob),
    // ` ` (word separator), `\` (escape).
    const jsonPayload = '{"a":"x #y;z&w","b":"path/*"}';
    await openAndroidApp(device, 'com.example.app', {
      launchArgs: ['--es', 'EXTRA_CONFIG', jsonPayload],
    });
    // `--es` and the safe extra key pass through unquoted; the JSON value
    // is single-quoted so `adb shell` re-tokenisation preserves it.
    assert.deepEqual(calls, [
      [
        'shell',
        'am',
        'start',
        '-W',
        '-a',
        'android.intent.action.MAIN',
        '-c',
        'android.intent.category.DEFAULT',
        '-c',
        'android.intent.category.LAUNCHER',
        '-p',
        'com.example.app',
        '--es',
        'EXTRA_CONFIG',
        `'${jsonPayload}'`,
      ],
    ]);
  });
});

test('openAndroidApp normalizes missing package launch failures into APP_NOT_INSTALLED', async () => {
  await withFakeAdb(
    (args) => {
      if (args[0] === 'shell' && args[1] === 'am' && args[2] === 'start') {
        // The launch call site does not pass allowFailure, so withFakeAdb
        // itself surfaces this nonzero exit as the production-shaped thrown
        // COMMAND_FAILED (androidAdbResultError) — no hand-modeled error.
        return { stderr: 'Error: Activity class does not exist.', exitCode: 1 };
      }
      if (args[0] === 'shell' && args[1] === 'pm' && args[2] === 'path') {
        // Probed with allowFailure: a returned nonzero result is the real shape.
        return { stderr: 'Error: unknown package: com.example.missing', exitCode: 1 };
      }
      return undefined;
    },
    async ({ device }) => {
      await assert.rejects(
        openAndroidApp(device, 'com.example.missing', '.MainActivity'),
        (error: unknown) => {
          assert.ok(error instanceof AppError);
          assert.equal(error.code, 'APP_NOT_INSTALLED');
          assert.match(String(error.details?.hint ?? ''), /agent-device apps --platform android/);
          return true;
        },
      );
    },
  );
});

test('openAndroidApp uses LEANBACK category for Android TV targets', async () => {
  await withFakeAdb(
    androidOpenFakeAdb,
    async ({ calls, device }) => {
      await openAndroidApp(device, 'com.example.tvapp');
      assert.deepEqual(calls, [
        [
          'shell',
          'am',
          'start',
          '-W',
          '-a',
          'android.intent.action.MAIN',
          '-c',
          'android.intent.category.DEFAULT',
          '-c',
          'android.intent.category.LEANBACK_LAUNCHER',
          '-p',
          'com.example.tvapp',
        ],
      ]);
    },
    { device: { ...ANDROID_EMULATOR, target: 'tv' } },
  );
});

test('openAndroidApp fallback resolve-activity includes MAIN/LAUNCHER flags', async () => {
  await withFakeAdb(
    (args) => {
      if (args[0] === 'shell' && args[1] === 'am' && args[2] === 'start') {
        // First am start (with -p) outputs error but exits 0 (real Android behavior)
        if (args.includes('-p')) {
          return [
            'Starting: Intent { act=android.intent.action.MAIN cat=[android.intent.category.DEFAULT,android.intent.category.LAUNCHER] pkg=com.microsoft.office.outlook }',
            'Error: Activity not started, unable to resolve Intent { act=android.intent.action.MAIN cat=[android.intent.category.DEFAULT,android.intent.category.LAUNCHER] flg=0x10000000 pkg=com.microsoft.office.outlook }',
          ].join('\n');
        }
        return 'Status: ok';
      }
      // resolve-activity returns correct launcher component
      if (
        args[0] === 'shell' &&
        args[1] === 'cmd' &&
        args[2] === 'package' &&
        args[3] === 'resolve-activity'
      ) {
        return [
          'priority=0 preferredOrder=0 match=0x108000 specificIndex=-1 isDefault=true',
          'com.microsoft.office.outlook/com.microsoft.office.outlook.ui.miit.MiitLauncherActivity',
        ].join('\n');
      }
      return undefined;
    },
    async ({ calls, device }) => {
      await openAndroidApp(device, 'com.microsoft.office.outlook');
      assert.deepEqual(calls, [
        [
          'shell',
          'am',
          'start',
          '-W',
          '-a',
          'android.intent.action.MAIN',
          '-c',
          'android.intent.category.DEFAULT',
          '-c',
          'android.intent.category.LAUNCHER',
          '-p',
          'com.microsoft.office.outlook',
        ],
        // resolve-activity was called with MAIN/LAUNCHER flags
        [
          'shell',
          'cmd',
          'package',
          'resolve-activity',
          '--brief',
          '-a',
          'android.intent.action.MAIN',
          '-c',
          'android.intent.category.LAUNCHER',
          'com.microsoft.office.outlook',
        ],
        // Fallback launch used the resolved component
        [
          'shell',
          'am',
          'start',
          '-W',
          '-a',
          'android.intent.action.MAIN',
          '-c',
          'android.intent.category.DEFAULT',
          '-c',
          'android.intent.category.LAUNCHER',
          '-n',
          'com.microsoft.office.outlook/com.microsoft.office.outlook.ui.miit.MiitLauncherActivity',
        ],
      ]);
    },
  );
});

// In-process replacement for the old PATH-stub default adb script: any
// `am start` succeeds with the "Status: ok" marker (so the primary launch
// never falls back to resolve-activity), everything else is empty success.
function androidOpenFakeAdb(args: string[]): FakeAdbResponse | undefined {
  if (args[0] === 'shell' && args[1] === 'am' && args[2] === 'start') return 'Status: ok';
  return undefined;
}
