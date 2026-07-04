import { test } from 'vitest';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setAndroidSetting } from '../settings.ts';
import type { DeviceInfo } from '../../../kernel/device.ts';
import { AppError } from '../../../kernel/errors.ts';
import { withScriptedAdb } from '../../../__tests__/test-utils/mocked-binaries.ts';

test('setAndroidSetting appearance toggle flips current mode', async () => {
  await withScriptedAdb(
    'agent-device-android-appearance-toggle-',
    [
      '#!/bin/sh',
      'printf "__CMD__\\n" >> "$AGENT_DEVICE_TEST_ARGS_FILE"',
      'printf "%s\\n" "$@" >> "$AGENT_DEVICE_TEST_ARGS_FILE"',
      'if [ "$1" = "-s" ] && [ "$4" = "cmd" ] && [ "$5" = "uimode" ] && [ "$6" = "night" ] && [ -z "$7" ]; then',
      '  echo "Night mode: yes"',
      '  exit 0',
      'fi',
      'exit 0',
      '',
    ].join('\n'),
    async ({ argsLogPath, device }) => {
      await setAndroidSetting(device, 'appearance', 'toggle');
      const lines = (await fs.readFile(argsLogPath, 'utf8')).trim().split('\n').filter(Boolean);
      const logged = lines.join(' ');
      assert.match(logged, /shell cmd uimode night __CMD__/);
      assert.match(logged, /shell cmd uimode night no/);
    },
  );
});

test('setAndroidSetting appearance toggle from auto sets dark mode', async () => {
  await withScriptedAdb(
    'agent-device-android-appearance-toggle-auto-',
    [
      '#!/bin/sh',
      'printf "__CMD__\\n" >> "$AGENT_DEVICE_TEST_ARGS_FILE"',
      'printf "%s\\n" "$@" >> "$AGENT_DEVICE_TEST_ARGS_FILE"',
      'if [ "$1" = "-s" ] && [ "$4" = "cmd" ] && [ "$5" = "uimode" ] && [ "$6" = "night" ] && [ -z "$7" ]; then',
      '  echo "Night mode: auto"',
      '  exit 0',
      'fi',
      'exit 0',
      '',
    ].join('\n'),
    async ({ argsLogPath, device }) => {
      await setAndroidSetting(device, 'appearance', 'toggle');
      const lines = (await fs.readFile(argsLogPath, 'utf8')).trim().split('\n').filter(Boolean);
      const logged = lines.join(' ');
      assert.match(logged, /shell cmd uimode night yes/);
    },
  );
});

test('setAndroidSetting appearance toggle rejects unknown current mode output', async () => {
  await withScriptedAdb(
    'agent-device-android-appearance-toggle-unknown-',
    [
      '#!/bin/sh',
      'if [ "$1" = "-s" ] && [ "$4" = "cmd" ] && [ "$5" = "uimode" ] && [ "$6" = "night" ] && [ -z "$7" ]; then',
      '  echo "mode unavailable"',
      '  exit 0',
      'fi',
      'exit 0',
      '',
    ].join('\n'),
    async ({ device }) => {
      await assert.rejects(
        () => setAndroidSetting(device, 'appearance', 'toggle'),
        (error: unknown) => {
          assert.equal(error instanceof AppError, true);
          assert.equal((error as AppError).code, 'COMMAND_FAILED');
          assert.match(
            (error as AppError).message,
            /Unable to determine current Android appearance/,
          );
          return true;
        },
      );
    },
  );
});

test('setAndroidSetting clear-app-state force stops and clears package data', async () => {
  await withScriptedAdb(
    'agent-device-android-clear-app-state-',
    [
      '#!/bin/sh',
      'printf "__CMD__\\n" >> "$AGENT_DEVICE_TEST_ARGS_FILE"',
      'printf "%s\\n" "$@" >> "$AGENT_DEVICE_TEST_ARGS_FILE"',
      'if [ "$1" = "-s" ]; then',
      '  shift',
      '  shift',
      'fi',
      'if [ "$1" = "shell" ] && [ "$2" = "am" ] && [ "$3" = "force-stop" ] && [ "$4" = "com.example.app" ]; then',
      '  exit 0',
      'fi',
      'if [ "$1" = "shell" ] && [ "$2" = "pm" ] && [ "$3" = "clear" ] && [ "$4" = "com.example.app" ]; then',
      '  echo "Success"',
      '  exit 0',
      'fi',
      'echo "unexpected args: $@" >&2',
      'exit 1',
      '',
    ].join('\n'),
    async ({ argsLogPath, device }) => {
      const result = await setAndroidSetting(device, 'clear-app-state', 'clear', 'com.example.app');
      assert.deepEqual(result, { package: 'com.example.app', cleared: true });
      const logged = await fs.readFile(argsLogPath, 'utf8');
      assert.match(logged, /shell\nam\nforce-stop\ncom\.example\.app/);
      assert.match(logged, /shell\npm\nclear\ncom\.example\.app/);
    },
  );
});

test('setAndroidSetting fingerprint retries emulator command when shell cmd fingerprint fails', async () => {
  await withScriptedAdb(
    'agent-device-android-fingerprint-fallback-',
    [
      '#!/bin/sh',
      'printf "__CMD__\\n" >> "$AGENT_DEVICE_TEST_ARGS_FILE"',
      'printf "%s\\n" "$@" >> "$AGENT_DEVICE_TEST_ARGS_FILE"',
      'if [ "$1" = "-s" ]; then',
      '  shift',
      '  shift',
      'fi',
      'if [ "$1" = "shell" ] && [ "$2" = "cmd" ] && [ "$3" = "fingerprint" ]; then',
      '  echo "fingerprint cmd unavailable" >&2',
      '  exit 1',
      'fi',
      'if [ "$1" = "emu" ] && [ "$2" = "finger" ] && [ "$3" = "touch" ] && [ "$4" = "1" ]; then',
      '  exit 0',
      'fi',
      'echo "unexpected args: $@" >&2',
      'exit 1',
      '',
    ].join('\n'),
    async ({ argsLogPath, device }) => {
      await setAndroidSetting(device, 'fingerprint', 'match');
      const logged = await fs.readFile(argsLogPath, 'utf8');
      assert.match(logged, /shell\ncmd\nfingerprint\ntouch\n1/);
      assert.match(logged, /shell\ncmd\nfingerprint\nfinger\n1/);
      assert.match(logged, /emu\nfinger\ntouch\n1/);
    },
  );
});

test('setAndroidSetting fingerprint rejects unsupported action', async () => {
  const device: DeviceInfo = {
    platform: 'android',
    id: 'emulator-5554',
    name: 'Pixel',
    kind: 'emulator',
    booted: true,
  };
  await assert.rejects(
    () => setAndroidSetting(device, 'fingerprint', 'enroll'),
    (error: unknown) => {
      assert.equal(error instanceof AppError, true);
      assert.equal((error as AppError).code, 'INVALID_ARGS');
      assert.match((error as AppError).message, /Invalid fingerprint state/);
      return true;
    },
  );
});

test('setAndroidSetting fingerprint returns COMMAND_FAILED for transport/runtime failures', async () => {
  await withScriptedAdb(
    'agent-device-android-fingerprint-command-failed-',
    ['#!/bin/sh', 'echo "error: device offline" >&2', 'exit 1', ''].join('\n'),
    async ({ device }) => {
      await assert.rejects(
        () => setAndroidSetting(device, 'fingerprint', 'match'),
        (error: unknown) => {
          assert.equal(error instanceof AppError, true);
          assert.equal((error as AppError).code, 'COMMAND_FAILED');
          assert.match((error as AppError).message, /Failed to simulate Android fingerprint/);
          return true;
        },
      );
    },
  );
});

test('setAndroidSetting fingerprint does not use adb emu command on physical devices', async () => {
  const tmpDir = await fs.mkdtemp(
    path.join(os.tmpdir(), 'agent-device-android-fingerprint-device-'),
  );
  const adbPath = path.join(tmpDir, 'adb');
  const argsLogPath = path.join(tmpDir, 'args.log');
  await fs.writeFile(
    adbPath,
    '#!/bin/sh\nprintf "__CMD__\\n" >> "$AGENT_DEVICE_TEST_ARGS_FILE"\nprintf "%s\\n" "$@" >> "$AGENT_DEVICE_TEST_ARGS_FILE"\necho "unknown command" >&2\nexit 1\n',
    'utf8',
  );
  await fs.chmod(adbPath, 0o755);

  const previousPath = process.env.PATH;
  const previousArgsFile = process.env.AGENT_DEVICE_TEST_ARGS_FILE;
  process.env.PATH = `${tmpDir}${path.delimiter}${previousPath ?? ''}`;
  process.env.AGENT_DEVICE_TEST_ARGS_FILE = argsLogPath;

  const device: DeviceInfo = {
    platform: 'android',
    id: 'R5CT11',
    name: 'Pixel Device',
    kind: 'device',
    booted: true,
  };

  try {
    await assert.rejects(() => setAndroidSetting(device, 'fingerprint', 'match'));
    const logged = await fs.readFile(argsLogPath, 'utf8');
    assert.doesNotMatch(logged, /\nemu\nfinger\ntouch\n/);
  } finally {
    process.env.PATH = previousPath;
    if (previousArgsFile === undefined) {
      delete process.env.AGENT_DEVICE_TEST_ARGS_FILE;
    } else {
      process.env.AGENT_DEVICE_TEST_ARGS_FILE = previousArgsFile;
    }
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('setAndroidSetting permission deny notifications revokes runtime permission and appops', async () => {
  await withScriptedAdb(
    'agent-device-android-permission-notifications-',
    '#!/bin/sh\nprintf "__CMD__\\n" >> "$AGENT_DEVICE_TEST_ARGS_FILE"\nprintf "%s\\n" "$@" >> "$AGENT_DEVICE_TEST_ARGS_FILE"\nexit 0\n',
    async ({ argsLogPath, device }) => {
      await setAndroidSetting(device, 'permission', 'deny', 'com.example.app', {
        permissionTarget: 'notifications',
      });
      const logged = await fs.readFile(argsLogPath, 'utf8');
      assert.match(
        logged,
        /shell\npm\nrevoke\ncom\.example\.app\nandroid\.permission\.POST_NOTIFICATIONS/,
      );
      assert.match(logged, /shell\nappops\nset\ncom\.example\.app\nPOST_NOTIFICATION\ndeny/);
    },
  );
});

test('setAndroidSetting permission reset notifications clears permission flags for reprompt', async () => {
  await withScriptedAdb(
    'agent-device-android-permission-notifications-reset-',
    '#!/bin/sh\nprintf "__CMD__\\n" >> "$AGENT_DEVICE_TEST_ARGS_FILE"\nprintf "%s\\n" "$@" >> "$AGENT_DEVICE_TEST_ARGS_FILE"\nexit 0\n',
    async ({ argsLogPath, device }) => {
      await setAndroidSetting(device, 'permission', 'reset', 'com.example.app', {
        permissionTarget: 'notifications',
      });
      const logged = await fs.readFile(argsLogPath, 'utf8');
      assert.match(
        logged,
        /shell\npm\nrevoke\ncom\.example\.app\nandroid\.permission\.POST_NOTIFICATIONS/,
      );
      assert.match(
        logged,
        /shell\npm\nclear-permission-flags\ncom\.example\.app\nandroid\.permission\.POST_NOTIFICATIONS\nuser-set/,
      );
      assert.match(
        logged,
        /shell\npm\nclear-permission-flags\ncom\.example\.app\nandroid\.permission\.POST_NOTIFICATIONS\nuser-fixed/,
      );
      assert.match(logged, /shell\nappops\nset\ncom\.example\.app\nPOST_NOTIFICATION\ndefault/);
    },
  );
});

test('setAndroidSetting permission reset camera maps to pm revoke', async () => {
  await withScriptedAdb(
    'agent-device-android-permission-reset-',
    '#!/bin/sh\nprintf "__CMD__\\n" >> "$AGENT_DEVICE_TEST_ARGS_FILE"\nprintf "%s\\n" "$@" >> "$AGENT_DEVICE_TEST_ARGS_FILE"\nexit 0\n',
    async ({ argsLogPath, device }) => {
      await setAndroidSetting(device, 'permission', 'reset', 'com.example.app', {
        permissionTarget: 'camera',
      });
      const logged = await fs.readFile(argsLogPath, 'utf8');
      assert.match(logged, /shell\npm\nrevoke\ncom\.example\.app\nandroid\.permission\.CAMERA/);
    },
  );
});

test('setAndroidSetting permission rejects mode argument', async () => {
  const device: DeviceInfo = {
    platform: 'android',
    id: 'emulator-5554',
    name: 'Pixel',
    kind: 'emulator',
    booted: true,
  };
  await assert.rejects(
    () =>
      setAndroidSetting(device, 'permission', 'grant', 'com.example.app', {
        permissionTarget: 'camera',
        permissionMode: 'limited',
      }),
    (error: unknown) => {
      assert.equal(error instanceof AppError, true);
      assert.equal((error as AppError).code, 'INVALID_ARGS');
      assert.match((error as AppError).message, /mode is only supported for photos/i);
      return true;
    },
  );
});

test('setAndroidSetting permission rejects iOS-only targets with Android-specific guidance', async () => {
  const device: DeviceInfo = {
    platform: 'android',
    id: 'emulator-5554',
    name: 'Pixel',
    kind: 'emulator',
    booted: true,
  };
  await assert.rejects(
    () =>
      setAndroidSetting(device, 'permission', 'grant', 'com.example.app', {
        permissionTarget: 'calendar',
      }),
    (error: unknown) => {
      assert.equal(error instanceof AppError, true);
      assert.equal((error as AppError).code, 'INVALID_ARGS');
      assert.match((error as AppError).message, /Unsupported permission target on Android/i);
      return true;
    },
  );
});

test('setAndroidSetting permission grant photos falls back to legacy permission on older SDK', async () => {
  await withScriptedAdb(
    'agent-device-android-permission-photos-fallback-',
    [
      '#!/bin/sh',
      'printf "__CMD__\\n" >> "$AGENT_DEVICE_TEST_ARGS_FILE"',
      'printf "%s\\n" "$@" >> "$AGENT_DEVICE_TEST_ARGS_FILE"',
      'if [ "$1" = "-s" ]; then',
      '  shift',
      '  shift',
      'fi',
      'if [ "$1" = "shell" ] && [ "$2" = "getprop" ] && [ "$3" = "ro.build.version.sdk" ]; then',
      '  echo "32"',
      '  exit 0',
      'fi',
      'if [ "$1" = "shell" ] && [ "$2" = "pm" ] && [ "$3" = "grant" ] && [ "$5" = "android.permission.READ_EXTERNAL_STORAGE" ]; then',
      '  exit 0',
      'fi',
      'echo "unexpected args: $@" >&2',
      'exit 1',
      '',
    ].join('\n'),
    async ({ argsLogPath, device }) => {
      await setAndroidSetting(device, 'permission', 'grant', 'com.example.app', {
        permissionTarget: 'photos',
      });
      const logged = await fs.readFile(argsLogPath, 'utf8');
      assert.match(logged, /shell\ngetprop\nro\.build\.version\.sdk/);
      assert.match(
        logged,
        /shell\npm\ngrant\ncom\.example\.app\nandroid\.permission\.READ_EXTERNAL_STORAGE/,
      );
    },
  );
});
