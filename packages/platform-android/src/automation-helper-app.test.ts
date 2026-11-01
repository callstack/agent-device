import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import { withAndroidAdbProvider } from './adb-executor.ts';
import { openAndroidApp } from './app-lifecycle.ts';
import { runAndroidAutomationHelper } from './automation-helper.ts';
import { ANDROID_EMULATOR } from './__tests__/test-utils/device-fixtures.ts';
import './__tests__/test-utils/android-host-test-setup.ts';

vi.mock('./automation-helper.ts', () => ({ runAndroidAutomationHelper: vi.fn() }));
const helper = vi.mocked(runAndroidAutomationHelper);
const hostShell = vi.fn(
  async (
    _args: readonly string[],
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> => {
    throw new Error('Unexpected host shell after helper admission');
  },
);
const pkg = 'com.example.app';

beforeEach(() => {
  helper.mockReset();
  hostShell.mockReset();
  hostShell.mockRejectedValue(new Error('Unexpected host shell after helper admission'));
});

afterEach(() => {
  vi.useRealTimers();
});

const timedOutLaunch = (activityPackage: string) =>
  `Starting: Intent { act=android.intent.action.MAIN cmp=${activityPackage}/.MainActivity }\n` +
  `Status: timeout\nLaunchState: UNKNOWN (-1)\nActivity: ${activityPackage}/.MainActivity\n` +
  'WaitTime: 10330\nComplete\n';

function focusedWindow(focusedPackage: string) {
  return {
    stdout: `mCurrentFocus=Window{42 u0 ${focusedPackage}/.MainActivity}\n`,
    stderr: '',
    exitCode: 0,
  };
}

async function isolated<T>(run: () => Promise<T>): Promise<T> {
  return await withAndroidAdbProvider({ exec: hostShell }, { serial: ANDROID_EMULATOR.id }, run);
}

test('a warm app open uses the helper launch result and preserves launched package identity', async () => {
  helper.mockResolvedValue({
    kind: 'launched',
    output: 'Status: ok\nActivity: com.example.app/.MainActivity\n',
  });
  await expect(isolated(() => openAndroidApp(ANDROID_EMULATOR, pkg))).resolves.toBe(pkg);
  expect(helper).toHaveBeenCalledWith(ANDROID_EMULATOR, {
    action: 'app',
    input: { kind: 'open', packageName: pkg },
  });
  expect(hostShell).not.toHaveBeenCalled();
});

test('a helper error after possible application mutation is returned without a shell resend', async () => {
  const failure = new AppError('COMMAND_FAILED', 'Helper transport lost after dispatch');
  helper.mockRejectedValue(failure);
  await expect(isolated(() => openAndroidApp(ANDROID_EMULATOR, pkg))).rejects.toBe(failure);
  expect(hostShell).not.toHaveBeenCalled();
});

test('a helper launch timeout without an Activity line is a failure and is never retried', async () => {
  helper.mockResolvedValue({
    kind: 'launched',
    output: 'Status: timeout\n',
  });
  await expect(isolated(() => openAndroidApp(ANDROID_EMULATOR, pkg))).rejects.toMatchObject({
    code: 'COMMAND_FAILED',
    message: 'Android helper could not launch the application',
  });
  expect(hostShell).not.toHaveBeenCalled();
});

test('a helper launch timeout naming another package is a failure without a foreground wait', async () => {
  helper.mockResolvedValue({ kind: 'launched', output: timedOutLaunch('com.example.other') });
  await expect(isolated(() => openAndroidApp(ANDROID_EMULATOR, pkg))).rejects.toMatchObject({
    code: 'COMMAND_FAILED',
    message: 'Android helper could not launch the application',
  });
  expect(hostShell).not.toHaveBeenCalled();
});

test('a dispatched helper launch timeout succeeds once the package reaches the foreground', async () => {
  helper.mockResolvedValue({ kind: 'launched', output: timedOutLaunch(pkg) });
  hostShell
    .mockResolvedValueOnce(focusedWindow('com.android.launcher'))
    .mockResolvedValue(focusedWindow(pkg));
  vi.useFakeTimers();
  const opened = isolated(() => openAndroidApp(ANDROID_EMULATOR, pkg));
  await vi.advanceTimersByTimeAsync(1_000);
  await expect(opened).resolves.toBe(pkg);
  expect(hostShell.mock.calls.map(([args]) => args)).toEqual([
    ['shell', 'dumpsys', 'window', 'windows'],
    ['shell', 'dumpsys', 'window', 'windows'],
  ]);
});

test('a dispatched helper launch timeout fails when the package never reaches the foreground', async () => {
  helper.mockResolvedValue({ kind: 'launched', output: timedOutLaunch(pkg) });
  hostShell.mockResolvedValue(focusedWindow('com.android.launcher'));
  vi.useFakeTimers();
  const opened = isolated(() => openAndroidApp(ANDROID_EMULATOR, pkg));
  const failure = expect(opened).rejects.toMatchObject({
    code: 'COMMAND_FAILED',
    details: { reason: 'android-launch-not-foreground', packageName: pkg, timeoutMs: 30_000 },
  });
  await vi.advanceTimersByTimeAsync(30_000);
  await failure;
  const shellCalls = hostShell.mock.calls.map(([args]) => args);
  expect(shellCalls.length).toBeGreaterThan(1);
  expect(shellCalls.every((args) => args.join(' ') === 'shell dumpsys window windows')).toBe(true);
});

test.each([true, false])(
  'an unavailable helper component distinguishes installed=%s without resending a launch',
  async (installed) => {
    helper.mockResolvedValue({ kind: 'component-unavailable' });
    hostShell.mockResolvedValue({
      stdout: installed ? 'package:/data/app/base.apk\n' : '',
      stderr: '',
      exitCode: installed ? 0 : 1,
    });
    await expect(isolated(() => openAndroidApp(ANDROID_EMULATOR, pkg))).rejects.toMatchObject({
      code: installed ? 'COMMAND_FAILED' : 'APP_NOT_INSTALLED',
    });
    expect(hostShell).toHaveBeenCalledTimes(1);
  },
);
