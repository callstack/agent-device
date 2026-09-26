import { beforeEach, test } from 'vitest';
import assert from 'node:assert/strict';
import { killAndroidApp } from '../app-lifecycle.ts';
import { withAndroidAdbProvider } from '../adb-executor.ts';
import { resetAndroidWindowDumpFocusMemoForTests } from '../window-state.ts';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { assertRejectsAppError } from './test-utils/app-error.ts';
import './test-utils/android-host-test-setup.ts';

// The kill precondition reads the AMS resumed activity, never WMS focus: input-focus transfer
// can lag activity resume after `launchApp`, a system window can own the focus while the target
// stays resumed (#592), and a transient window (IME, dialog) can own it for one sample. These
// tests pin that authority against AMS fixtures paired with a disagreeing WMS focus dump.

const RESUMED_TARGET_DUMP =
  '  mResumedActivity: ActivityRecord{99 u0 com.example.app/.MainActivity t7}\n';
const RESUMED_LAUNCHER_DUMP =
  '  mResumedActivity: ActivityRecord{98 u0 com.android.launcher/.Launcher t1}\n';
const STALE_LAUNCHER_FOCUS_DUMP = 'mCurrentFocus=Window{43 u0 com.android.launcher/.Launcher}\n';
const TARGET_FOCUS_DUMP = 'mCurrentFocus=Window{42 u0 com.example.app/.MainActivity}\n';

const dumpsysActivityActivities = ['shell', 'dumpsys', 'activity', 'activities'].join(' ');
const dumpsysWindowWindows = ['shell', 'dumpsys', 'window', 'windows'].join(' ');
const pidofTarget = ['shell', 'pidof', 'com.example.app'].join(' ');

const DEVICE: DeviceInfo = {
  platform: 'android',
  id: 'emulator-5554',
  name: 'Pixel',
  kind: 'emulator',
  booted: true,
};

const noReverse = {
  ensure: async () => {},
  remove: async () => {},
  removeAllOwned: async () => {},
};

beforeEach(() => {
  resetAndroidWindowDumpFocusMemoForTests();
});

test('killAndroidApp dispatches am kill rather than am force-stop', async () => {
  const calls: (readonly string[])[] = [];

  await withAndroidAdbProvider(
    {
      exec: async (args) => {
        calls.push(args);
        const command = args.join(' ');
        if (command === dumpsysActivityActivities) {
          return { stdout: RESUMED_LAUNCHER_DUMP, stderr: '', exitCode: 0 };
        }
        if (command === dumpsysWindowWindows) {
          return { stdout: STALE_LAUNCHER_FOCUS_DUMP, stderr: '', exitCode: 0 };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      },
      reverse: noReverse,
    },
    { serial: 'emulator-5554' },
    async () => await killAndroidApp(DEVICE, 'com.example.app'),
  );

  assert.deepEqual(calls, [
    ['shell', 'dumpsys', 'activity', 'activities'],
    ['shell', 'am', 'kill', 'com.example.app'],
    ['shell', 'dumpsys', 'window', 'windows'],
    ['shell', 'pidof', 'com.example.app'],
    ['shell', 'pidof', 'com.example.app'],
    ['shell', 'pidof', 'com.example.app'],
  ]);
});

test('killAndroidApp refuses when the resumed activity names the target behind stale launcher focus', async () => {
  const calls: (readonly string[])[] = [];

  await withAndroidAdbProvider(
    {
      exec: async (args) => {
        calls.push(args);
        const command = args.join(' ');
        // Stale WMS focus right after `launchApp`: the previous app still owns the focused
        // window while AMS already shows the target resumed. The old foreground-first read
        // trusted this dump and skipped the refusal.
        if (command === dumpsysWindowWindows) {
          return { stdout: STALE_LAUNCHER_FOCUS_DUMP, stderr: '', exitCode: 0 };
        }
        if (command === dumpsysActivityActivities) {
          return { stdout: RESUMED_TARGET_DUMP, stderr: '', exitCode: 0 };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      },
      reverse: noReverse,
    },
    { serial: 'emulator-5554' },
    async () => {
      await assertRejectsAppError(() => killAndroidApp(DEVICE, 'com.example.app'), {
        code: 'COMMAND_FAILED',
        hint: /Background the app before killApp/,
        details: { reason: 'android-kill-requires-background-app' },
      });
    },
  );

  // The precondition never consults WMS focus: one AMS read decides, and no kill is dispatched.
  assert.deepEqual(calls, [['shell', 'dumpsys', 'activity', 'activities']]);
});

test('killAndroidApp proceeds when focus still names the target but the resumed activity moved on', async () => {
  const calls: (readonly string[])[] = [];
  let windowReads = 0;

  await withAndroidAdbProvider(
    {
      exec: async (args) => {
        calls.push(args);
        const command = args.join(' ');
        if (command === dumpsysActivityActivities) {
          return { stdout: RESUMED_LAUNCHER_DUMP, stderr: '', exitCode: 0 };
        }
        if (command === dumpsysWindowWindows) {
          windowReads += 1;
          // WMS focus still names the target (lag after `pressKey: Home`, or a transient
          // window); the first window read happens after the kill, in the stop wait.
          return {
            stdout: windowReads === 1 ? TARGET_FOCUS_DUMP : STALE_LAUNCHER_FOCUS_DUMP,
            stderr: '',
            exitCode: 0,
          };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      },
      reverse: noReverse,
    },
    { serial: 'emulator-5554' },
    async () => await killAndroidApp(DEVICE, 'com.example.app'),
  );

  // The AMS read comes first and the kill is dispatched even though WMS named the target.
  // The full sequence pins that no WMS read happens before the kill: the two window reads are
  // the post-kill stop wait (TARGET focus once, then STALE).
  assert.deepEqual(calls, [
    ['shell', 'dumpsys', 'activity', 'activities'],
    ['shell', 'am', 'kill', 'com.example.app'],
    ['shell', 'dumpsys', 'window', 'windows'],
    ['shell', 'dumpsys', 'window', 'windows'],
    ['shell', 'pidof', 'com.example.app'],
    ['shell', 'pidof', 'com.example.app'],
    ['shell', 'pidof', 'com.example.app'],
  ]);
});

test('killAndroidApp fails when the process survives the kill', async () => {
  await withAndroidAdbProvider(
    {
      exec: async (args) => {
        const command = args.join(' ');
        if (command === dumpsysActivityActivities) {
          return { stdout: RESUMED_LAUNCHER_DUMP, stderr: '', exitCode: 0 };
        }
        if (command === dumpsysWindowWindows) {
          return { stdout: STALE_LAUNCHER_FOCUS_DUMP, stderr: '', exitCode: 0 };
        }
        if (command === pidofTarget) {
          return { stdout: '12345\n', stderr: '', exitCode: 0 };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      },
      reverse: noReverse,
    },
    { serial: 'emulator-5554' },
    async () => {
      await assertRejectsAppError(() => killAndroidApp(DEVICE, 'com.example.app'), {
        code: 'COMMAND_FAILED',
        hint: /foreground service|force-stop/,
        details: { reason: 'android-kill-process-survived' },
      });
    },
  );
});

test('killAndroidApp fails when the liveness probe itself cannot answer', async () => {
  await withAndroidAdbProvider(
    {
      exec: async (args) => {
        const command = args.join(' ');
        if (command === dumpsysActivityActivities) {
          return { stdout: RESUMED_LAUNCHER_DUMP, stderr: '', exitCode: 0 };
        }
        if (command === dumpsysWindowWindows) {
          return { stdout: STALE_LAUNCHER_FOCUS_DUMP, stderr: '', exitCode: 0 };
        }
        if (command === pidofTarget) {
          return { stdout: '', stderr: 'error: device offline\n', exitCode: 1 };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      },
      reverse: noReverse,
    },
    { serial: 'emulator-5554' },
    async () => {
      await assertRejectsAppError(() => killAndroidApp(DEVICE, 'com.example.app'), {
        code: 'COMMAND_FAILED',
        hint: /pidof did not answer/,
        details: { reason: 'android-process-probe-unavailable' },
      });
    },
  );
});

test('killAndroidApp fails closed when the resumed-activity probe cannot answer', async () => {
  const calls: (readonly string[])[] = [];

  await withAndroidAdbProvider(
    {
      exec: async (args) => {
        calls.push(args);
        return { stdout: '', stderr: '', exitCode: 0 };
      },
      reverse: noReverse,
    },
    { serial: 'emulator-5554' },
    async () => {
      await assertRejectsAppError(() => killAndroidApp(DEVICE, 'com.example.app'), {
        code: 'COMMAND_FAILED',
        hint: /dumpsys did not answer/,
        details: { reason: 'android-process-probe-unavailable' },
      });
    },
  );

  // Both AMS variants are asked before failing closed, and no kill is dispatched.
  assert.deepEqual(calls, [
    ['shell', 'dumpsys', 'activity', 'activities'],
    ['shell', 'dumpsys', 'activity'],
  ]);
});
