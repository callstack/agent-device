import { beforeEach, expect, test, vi } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import { withAndroidAdbProvider } from './adb-executor.ts';
import { openAndroidApp } from './app-lifecycle.ts';
import { runAndroidAutomationHelper } from './automation-helper.ts';
import { ANDROID_EMULATOR } from './__tests__/test-utils/device-fixtures.ts';
import './__tests__/test-utils/android-host-test-setup.ts';

vi.mock('./automation-helper.ts', () => ({ runAndroidAutomationHelper: vi.fn() }));
const helper = vi.mocked(runAndroidAutomationHelper);
const hostShell = vi.fn(async (): Promise<{ stdout: string; stderr: string; exitCode: number }> => {
  throw new Error('Unexpected host shell after helper admission');
});
const pkg = 'com.example.app';

beforeEach(() => {
  helper.mockReset();
  hostShell.mockReset();
  hostShell.mockRejectedValue(new Error('Unexpected host shell after helper admission'));
});

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

test('an unsuccessful helper launch is a failure and is never retried as a host launch', async () => {
  helper.mockResolvedValue({
    kind: 'launched',
    output: 'Status: timeout\n',
  });
  await expect(isolated(() => openAndroidApp(ANDROID_EMULATOR, pkg))).rejects.toMatchObject({
    code: 'COMMAND_FAILED',
  });
  expect(hostShell).not.toHaveBeenCalled();
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
