import { test, vi } from 'vitest';
import assert from 'node:assert/strict';
import { closeAndroidApp, openAndroidApp } from '../app-lifecycle.ts';
import { withAndroidAdbProvider } from '../adb-executor.ts';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import { ANDROID_EMULATOR } from './test-utils/device-fixtures.ts';
import './test-utils/android-host-test-setup.ts';

test('closeAndroidApp waits until package is no longer foreground', async () => {
  const device: DeviceInfo = {
    platform: 'android',
    id: 'emulator-5554',
    name: 'Pixel',
    kind: 'emulator',
    booted: true,
  };
  const calls: (readonly string[])[] = [];
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
  const calls: (readonly string[])[] = [];

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
  const calls: (readonly string[])[] = [];
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

test.each(['foreground', 'process'] as const)(
  'closeAndroidApp refuses an exhausted %s fence',
  async (phase) => {
    vi.useFakeTimers();
    const calls: (readonly string[])[] = [];
    try {
      await withAndroidAdbProvider(
        {
          exec: async (args) => {
            calls.push(args);
            const stdout =
              args[1] === 'pidof'
                ? '12345\n'
                : args[1] === 'dumpsys'
                  ? `mCurrentFocus=Window{42 u0 ${phase === 'foreground' ? 'com.example.app/.MainActivity' : 'com.android.launcher/.Launcher'}}\n`
                  : '';
            return { stdout, stderr: '', exitCode: 0 };
          },
        },
        { serial: ANDROID_EMULATOR.id },
        async () => {
          const rejection = assert.rejects(
            closeAndroidApp(ANDROID_EMULATOR, 'com.example.app'),
            (error: unknown) => {
              assert.ok(error instanceof AppError);
              assert.equal(error.code, 'COMMAND_FAILED');
              assert.deepEqual(error.details, {
                reason: 'android-app-close-timeout',
                phase,
                packageName: 'com.example.app',
                timeoutMs: 2_000,
              });
              return true;
            },
          );
          await Promise.all([rejection, vi.runAllTimersAsync()]);
        },
      );
      assert.deepEqual(calls[0], ['shell', 'am', 'force-stop', 'com.example.app']);
      assert.equal(
        calls.filter((args) => args[1] === 'pidof').length,
        phase === 'process' ? 40 : 0,
      );
    } finally {
      vi.useRealTimers();
    }
  },
);

test.each([
  ['foreground', 1, 1_999, true, 2],
  ['foreground', 1, 2_000, false, 0],
  ['foreground', 1, 2_001, false, 0],
  ['process', 1, 1_849, true, 2],
  ['process', 1, 1_850, false, 1],
  ['process', 1, 2_000, false, 1],
  ['process', 1, 2_001, false, 1],
  ['process', 2, 1_999, true, 2],
  ['process', 2, 2_000, false, 2],
  ['process', 2, 2_001, false, 2],
] as const)(
  'closeAndroidApp admits %s probe %i completing at %ims only within its fence (success=%s)',
  async (phase, probe, completionMs, succeeds, expectedProcessPolls) => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    let processPolls = 0;
    try {
      await withAndroidAdbProvider(
        {
          exec: async (args) => {
            if (args[1] === 'pidof') processPolls += 1;
            if (
              (phase === 'foreground' && args[1] === 'dumpsys') ||
              (phase === 'process' && args[1] === 'pidof' && processPolls === probe)
            ) {
              await new Promise((resolve) => setTimeout(resolve, completionMs - Date.now()));
            }
            return {
              stdout:
                args[1] === 'dumpsys'
                  ? 'mCurrentFocus=Window{43 u0 com.android.launcher/.Launcher}\n'
                  : '',
              stderr: '',
              exitCode: args[1] === 'pidof' ? 1 : 0,
            };
          },
        },
        { serial: ANDROID_EMULATOR.id },
        async () => {
          const close = closeAndroidApp(ANDROID_EMULATOR, 'com.example.app');
          const result = succeeds
            ? close
            : assert.rejects(close, (error: unknown) => {
                assert.ok(error instanceof AppError);
                assert.equal(error.code, 'COMMAND_FAILED');
                assert.deepEqual(error.details, {
                  reason: 'android-app-close-timeout',
                  phase,
                  packageName: 'com.example.app',
                  timeoutMs: 2_000,
                });
                return true;
              });
          await Promise.all([result, vi.runAllTimersAsync()]);
        },
      );
      assert.equal(processPolls, expectedProcessPolls);
    } finally {
      vi.useRealTimers();
    }
  },
);

test('openAndroidApp refuses to relaunch a package whose stop fence expires', async () => {
  vi.useFakeTimers();
  const calls: (readonly string[])[] = [];
  try {
    await withAndroidAdbProvider(
      {
        exec: async (args) => {
          calls.push(args);
          const stdout =
            args[1] === 'dumpsys'
              ? 'mCurrentFocus=Window{42 u0 com.example.app/.MainActivity}\n'
              : '';
          return { stdout, stderr: '', exitCode: 0 };
        },
      },
      { serial: ANDROID_EMULATOR.id },
      async () => {
        const rejection = assert.rejects(
          openAndroidApp(ANDROID_EMULATOR, 'com.example.app', { terminateRunningApp: true }),
          (error: unknown) =>
            error instanceof AppError &&
            error.details?.reason === 'android-app-close-timeout' &&
            error.details?.phase === 'foreground',
        );
        await Promise.all([rejection, vi.runAllTimersAsync()]);
      },
    );
    assert.deepEqual(calls[0], ['shell', 'am', 'force-stop', 'com.example.app']);
    assert.equal(calls.filter((args) => args[2] === 'start').length, 0, 'no launch after refusal');
  } finally {
    vi.useRealTimers();
  }
});
