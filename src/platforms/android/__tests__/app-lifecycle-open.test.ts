import { test } from 'vitest';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { closeAndroidApp, openAndroidApp } from '../app-lifecycle.ts';
import { withAndroidAdbProvider } from '../adb-executor.ts';
import type { DeviceInfo } from '../../../kernel/device.ts';
import { AppError } from '../../../kernel/errors.ts';
import { withScriptedAdb } from '../../../__tests__/test-utils/mocked-binaries.ts';

test('openAndroidApp rejects activity override for deep link URLs', async () => {
  const device: DeviceInfo = {
    platform: 'android',
    id: 'emulator-5554',
    name: 'Pixel',
    kind: 'emulator',
    booted: true,
  };

  await assert.rejects(
    () => openAndroidApp(device, '  https://example.com/path  ', '.MainActivity'),
    (error: unknown) => {
      assert.equal(error instanceof AppError, true);
      assert.equal((error as AppError).code, 'INVALID_ARGS');
      return true;
    },
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
        'http://[::1]:8081/status',
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
  await withScriptedAdb(
    'agent-device-android-open-deep-link-package-',
    [
      '#!/bin/sh',
      'printf "__CMD__\\n" >> "$AGENT_DEVICE_TEST_ARGS_FILE"',
      'printf "%s\\n" "$@" >> "$AGENT_DEVICE_TEST_ARGS_FILE"',
      'if [ "$1" = "-s" ]; then',
      '  shift',
      '  shift',
      'fi',
      'if [ "$1" = "shell" ] && [ "$2" = "pm" ] && [ "$3" = "list" ]; then',
      '  echo "package:com.example.app"',
      '  exit 0',
      'fi',
      'if [ "$1" = "shell" ] && [ "$2" = "am" ] && [ "$3" = "start" ]; then',
      '  echo "Status: ok"',
      '  exit 0',
      'fi',
      'exit 0',
      '',
    ].join('\n'),
    async ({ argsLogPath, device }) => {
      await openAndroidApp(device, 'com.example.app', { url: 'example://bottom-tabs' });
      const logged = await fs.readFile(argsLogPath, 'utf8');
      assert.match(logged, /shell\nam\nstart\n-W\n-a\nandroid\.intent\.action\.VIEW/);
      assert.match(logged, /-d\nexample:\/\/bottom-tabs/);
      assert.match(logged, /-p\ncom\.example\.app/);
    },
  );
});

test('openAndroidApp default launch uses -p package flag', async () => {
  await withScriptedAdb(
    'agent-device-android-open-default-',
    androidOpenAdbScript(),
    async ({ argsLogPath, device }) => {
      await openAndroidApp(device, 'com.example.app');
      const logged = await fs.readFile(argsLogPath, 'utf8');
      assert.match(logged, /shell\nam\nstart\n-W\n-a\nandroid\.intent\.action\.MAIN/);
      assert.match(logged, /-p\ncom\.example\.app/);
    },
  );
});

test('openAndroidApp appends launchArgs to am start when launching by package', async () => {
  await withScriptedAdb(
    'agent-device-android-open-launch-args-',
    androidOpenAdbScript(),
    async ({ argsLogPath, device }) => {
      await openAndroidApp(device, 'com.example.app', {
        launchArgs: ['--es', 'screen', 'home', '--ez', 'fresh', 'true'],
      });
      const logged = await fs.readFile(argsLogPath, 'utf8');
      assert.match(logged, /-p\ncom\.example\.app\n--es\nscreen\nhome\n--ez\nfresh\ntrue/);
    },
  );
});

test('openAndroidApp appends launchArgs to am start when activity override is set', async () => {
  await withScriptedAdb(
    'agent-device-android-open-launch-args-activity-',
    androidOpenAdbScript(),
    async ({ argsLogPath, device }) => {
      await openAndroidApp(device, 'com.example.app', {
        activity: '.MainActivity',
        launchArgs: ['--es', 'mode', 'debug'],
      });
      const logged = await fs.readFile(argsLogPath, 'utf8');
      assert.match(logged, /-n\ncom\.example\.app\/\.MainActivity\n--es\nmode\ndebug/);
    },
  );
});

test('openAndroidApp appends launchArgs to am start for deep link URL opens', async () => {
  await withScriptedAdb(
    'agent-device-android-open-launch-args-url-',
    androidOpenAdbScript(),
    async ({ argsLogPath, device }) => {
      await openAndroidApp(device, 'myapp://item/42', {
        launchArgs: ['--es', 'ref', 'campaign'],
      });
      const logged = await fs.readFile(argsLogPath, 'utf8');
      assert.match(logged, /-d\nmyapp:\/\/item\/42\n--es\nref\ncampaign/);
    },
  );
});

test('openAndroidApp appends launchArgs to am start for app-bound URL opens', async () => {
  await withScriptedAdb(
    'agent-device-android-open-launch-args-app-bound-url-',
    androidOpenAdbScript(),
    async ({ argsLogPath, device }) => {
      await openAndroidApp(device, 'com.example.app', {
        url: 'https://example.com/promo',
        launchArgs: ['--es', 'ref', 'campaign'],
      });
      const logged = await fs.readFile(argsLogPath, 'utf8');
      assert.match(
        logged,
        /-d\nhttps:\/\/example\.com\/promo\n-p\ncom\.example\.app\n--es\nref\ncampaign/,
      );
    },
  );
});

test('openAndroidApp shell-quotes launchArgs containing JSON or shell metacharacters', async () => {
  await withScriptedAdb(
    'agent-device-android-open-launch-args-quoting-',
    androidOpenAdbScript(),
    async ({ argsLogPath, device }) => {
      // Value contains characters the device shell would otherwise re-interpret:
      // `#` (comment), `;` (statement separator), `&` (background), `*` (glob),
      // ` ` (word separator), `\` (escape).
      const jsonPayload = '{"a":"x #y;z&w","b":"path/*"}';
      await openAndroidApp(device, 'com.example.app', {
        launchArgs: ['--es', 'EXTRA_CONFIG', jsonPayload],
      });
      const logged = await fs.readFile(argsLogPath, 'utf8');
      // `--es` and the safe extra key pass through unquoted; the JSON value
      // is single-quoted so `adb shell` re-tokenisation preserves it.
      assert.match(logged, /--es\nEXTRA_CONFIG\n'\{"a":"x #y;z&w","b":"path\/\*"\}'/);
    },
  );
});

test('openAndroidApp normalizes missing package launch failures into APP_NOT_INSTALLED', async () => {
  await withScriptedAdb(
    'agent-device-android-open-missing-package-',
    [
      '#!/bin/sh',
      'if [ "$1" = "-s" ]; then',
      '  shift',
      '  shift',
      'fi',
      'if [ "$1" = "shell" ] && [ "$2" = "am" ] && [ "$3" = "start" ]; then',
      '  echo "Error: Activity class does not exist." >&2',
      '  exit 1',
      'fi',
      'if [ "$1" = "shell" ] && [ "$2" = "pm" ] && [ "$3" = "path" ]; then',
      '  echo "Error: unknown package: com.example.missing" >&2',
      '  exit 1',
      'fi',
      'exit 0',
      '',
    ].join('\n'),
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
  await withScriptedAdb(
    'agent-device-android-open-tv-',
    [
      '#!/bin/sh',
      'printf "__CMD__\\n" >> "$AGENT_DEVICE_TEST_ARGS_FILE"',
      'printf "%s\\n" "$@" >> "$AGENT_DEVICE_TEST_ARGS_FILE"',
      'if [ "$1" = "-s" ]; then',
      '  shift',
      '  shift',
      'fi',
      'if [ "$1" = "shell" ] && [ "$2" = "pm" ] && [ "$3" = "list" ]; then',
      '  echo "package:com.example.tvapp"',
      '  exit 0',
      'fi',
      'if [ "$1" = "shell" ] && [ "$2" = "am" ] && [ "$3" = "start" ]; then',
      '  echo "Status: ok"',
      '  exit 0',
      'fi',
      'exit 0',
      '',
    ].join('\n'),
    async ({ argsLogPath, device }) => {
      await openAndroidApp({ ...device, target: 'tv' }, 'com.example.tvapp');
      const logged = await fs.readFile(argsLogPath, 'utf8');
      assert.match(logged, /-c\nandroid\.intent\.category\.LEANBACK_LAUNCHER/);
      assert.match(logged, /-p\ncom\.example\.tvapp/);
    },
  );
});

test('openAndroidApp fallback resolve-activity includes MAIN/LAUNCHER flags', async () => {
  await withScriptedAdb(
    'agent-device-android-open-fallback-',
    [
      '#!/bin/sh',
      'printf "__CMD__\\n" >> "$AGENT_DEVICE_TEST_ARGS_FILE"',
      'printf "%s\\n" "$@" >> "$AGENT_DEVICE_TEST_ARGS_FILE"',
      'if [ "$1" = "-s" ]; then',
      '  shift',
      '  shift',
      'fi',
      'if [ "$1" = "shell" ] && [ "$2" = "pm" ] && [ "$3" = "list" ]; then',
      '  echo "package:com.microsoft.office.outlook"',
      '  exit 0',
      'fi',
      '# First am start (with -p) outputs error but exits 0 (real Android behavior)',
      'if [ "$1" = "shell" ] && [ "$2" = "am" ] && [ "$3" = "start" ]; then',
      '  for arg in "$@"; do',
      '    if [ "$arg" = "-p" ]; then',
      '      echo "Starting: Intent { act=android.intent.action.MAIN cat=[android.intent.category.DEFAULT,android.intent.category.LAUNCHER] pkg=com.microsoft.office.outlook }"',
      '      echo "Error: Activity not started, unable to resolve Intent { act=android.intent.action.MAIN cat=[android.intent.category.DEFAULT,android.intent.category.LAUNCHER] flg=0x10000000 pkg=com.microsoft.office.outlook }"',
      '      exit 0',
      '    fi',
      '  done',
      '  echo "Status: ok"',
      '  exit 0',
      'fi',
      '# resolve-activity returns correct launcher component',
      'if [ "$1" = "shell" ] && [ "$2" = "cmd" ] && [ "$3" = "package" ] && [ "$4" = "resolve-activity" ]; then',
      '  echo "priority=0 preferredOrder=0 match=0x108000 specificIndex=-1 isDefault=true"',
      '  echo "com.microsoft.office.outlook/com.microsoft.office.outlook.ui.miit.MiitLauncherActivity"',
      '  exit 0',
      'fi',
      'exit 0',
      '',
    ].join('\n'),
    async ({ argsLogPath, device }) => {
      await openAndroidApp(device, 'com.microsoft.office.outlook');
      const logged = await fs.readFile(argsLogPath, 'utf8');
      // Verify resolve-activity was called with MAIN/LAUNCHER flags
      assert.match(
        logged,
        /resolve-activity\n--brief\n-a\nandroid\.intent\.action\.MAIN\n-c\nandroid\.intent\.category\.LAUNCHER\ncom\.microsoft\.office\.outlook/,
      );
      // Verify fallback launch used the resolved component
      assert.match(
        logged,
        /-n\ncom\.microsoft\.office\.outlook\/com\.microsoft\.office\.outlook\.ui\.miit\.MiitLauncherActivity/,
      );
    },
  );
});

function androidOpenAdbScript(): string {
  return [
    '#!/bin/sh',
    'printf "__CMD__\\n" >> "$AGENT_DEVICE_TEST_ARGS_FILE"',
    'printf "%s\\n" "$@" >> "$AGENT_DEVICE_TEST_ARGS_FILE"',
    'if [ "$1" = "-s" ]; then',
    '  shift',
    '  shift',
    'fi',
    'if [ "$1" = "shell" ] && [ "$2" = "am" ] && [ "$3" = "start" ]; then',
    '  echo "Status: ok"',
    '  exit 0',
    'fi',
    'exit 0',
    '',
  ].join('\n');
}
