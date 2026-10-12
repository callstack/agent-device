import assert from 'node:assert/strict';
import { beforeEach, test, vi } from 'vitest';
import type { DeviceInfo } from '@agent-device/kernel/device';

vi.mock('@agent-device/host-kit/command', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent-device/host-kit/command')>();
  return {
    ...actual,
    runCmd: vi.fn(),
    runCmdDetached: vi.fn(),
    whichCmd: vi.fn(),
  };
});
vi.mock('../sdk.ts', () => ({ ensureAndroidSdkPathConfigured: vi.fn(async () => {}) }));

import './test-utils/android-host-test-setup.ts';
import { runCmd, runCmdDetached, whichCmd } from '@agent-device/host-kit/command';
import { AppError } from '@agent-device/kernel/errors';
import { ensureAndroidEmulatorBooted, waitForAndroidBoot } from '../emulator-lifecycle.ts';

const stopped: DeviceInfo = {
  platform: 'android',
  id: 'Pixel_9_Pro_XL',
  name: 'Pixel_9_Pro_XL',
  kind: 'emulator',
  target: 'mobile',
  booted: false,
};
const running: DeviceInfo = {
  ...stopped,
  id: 'emulator-5554',
  name: 'Pixel 9 Pro XL',
  booted: true,
};

const mockRunCmd = vi.mocked(runCmd);
const mockRunCmdDetached = vi.mocked(runCmdDetached);
const mockWhichCmd = vi.mocked(whichCmd);

beforeEach(() => {
  mockRunCmd.mockReset();
  mockRunCmd.mockResolvedValue({ stdout: '1\n', stderr: '', exitCode: 0 });
  mockRunCmdDetached.mockReset();
  mockRunCmdDetached.mockReturnValue(1234);
  mockWhichCmd.mockReset();
  mockWhichCmd.mockResolvedValue(true);
});

test('emulator boot adopts package-owned local discovery and launches a stopped AVD', async () => {
  const requests: unknown[] = [];
  const discoveries = [[stopped], [running], [running]];
  const discoverLocal = vi.fn(async (request) => {
    requests.push(request);
    return discoveries.shift() ?? [running];
  });

  const device = await ensureAndroidEmulatorBooted(
    { avdName: 'Pixel 9 Pro XL', timeoutMs: 5_000, headless: true },
    { discoverLocal },
  );

  assert.equal(device.id, 'emulator-5554');
  assert.equal(device.booted, true);
  assert.deepEqual(requests[0], { platform: 'android', kind: 'emulator' });
  assert.deepEqual(mockRunCmdDetached.mock.calls[0]?.slice(0, 2), [
    'emulator',
    ['-avd', 'Pixel_9_Pro_XL', '-no-window', '-no-audio'],
  ]);
});

test('emulator boot reuses a matching running emulator without relaunching', async () => {
  const discoverLocal = vi.fn(async () => [running]);

  const device = await ensureAndroidEmulatorBooted(
    { avdName: 'Pixel_9_Pro_XL', timeoutMs: 5_000, headless: true },
    { discoverLocal },
  );

  assert.equal(device.id, running.id);
  assert.equal(mockRunCmdDetached.mock.calls.length, 0);
});

test('emulator boot excludes a running serial outside the resolved Android allowlist', async () => {
  const requests: Array<{ androidSerialAllowlist?: string[] }> = [];
  const dependencies = {
    androidSerialAllowlist: ['emulator-9999'],
    discoverLocal: vi.fn(async (request: { androidSerialAllowlist?: string[] }) => {
      requests.push(request);
      return request.androidSerialAllowlist ? [] : [running];
    }),
  };

  await assert.rejects(
    ensureAndroidEmulatorBooted(
      { avdName: 'Pixel_9_Pro_XL', timeoutMs: 5_000, headless: true },
      dependencies,
    ),
    (error: unknown) =>
      error instanceof Error && 'code' in error && error.code === 'DEVICE_NOT_FOUND',
  );

  assert.deepEqual(requests[0]?.androidSerialAllowlist, ['emulator-9999']);
  assert.equal(mockRunCmdDetached.mock.calls.length, 0);
});

function bootPropFailure(stdout: string, stderr: string) {
  return async () => {
    await Promise.resolve();
    return { stdout, stderr, exitCode: 1 };
  };
}

/** A poll that keeps missing like a real booting device does and burns the given clock time. */
function slowBootPropFailure(delayMs: number) {
  return async () => {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    return { stdout: '', stderr: '', exitCode: 1 };
  };
}

/**
 * Starts the wait and resolves to the typed failure it must produce. The caller drives any timers
 * between starting and awaiting when the test runs on a fake clock.
 */
function startedBootFailure(
  timeoutMs: number,
): Promise<{ code: string; message: string; details: Record<string, unknown> }> {
  return waitForAndroidBoot('emulator-5554', timeoutMs).then(
    () => {
      throw new Error('expected waitForAndroidBoot to reject');
    },
    (error: AppError) => ({
      code: error.code,
      message: error.message,
      details: (error.details ?? {}) as Record<string, unknown>,
    }),
  );
}

async function expectBootFailure(
  timeoutMs: number,
): Promise<{ code: string; message: string; details: Record<string, unknown> }> {
  return await startedBootFailure(timeoutMs);
}

test('a boot poll against an offline device fails as an adb transport loss without retrying', async () => {
  mockRunCmd.mockImplementation(bootPropFailure('', 'error: device offline'));

  const failure = await expectBootFailure(500);

  assert.equal(failure.code, 'COMMAND_FAILED');
  assert.equal(failure.details.reason, 'ADB_TRANSPORT_UNAVAILABLE');
  assert.match(String(failure.details.hint), /adb devices -l/);
  assert.equal(failure.details.serial, 'emulator-5554');
  assert.equal(failure.details.stderr, 'error: device offline');
  assert.equal(failure.details.exitCode, 1);
  // shouldRetry refuses the transport loss, so exactly one poll ran.
  assert.equal(mockRunCmd.mock.calls.length, 1);
});

test('a still-booting device past its deadline reports an Android boot timeout', async () => {
  // On a fake clock: each poll burns 80 ms, and the 150 ms deadline is crossed inside the
  // second poll, so the failure is a device that ran out of budget, not a run of fast poll
  // misses. Fake timers keep the 80 ms/150 ms geometry exact instead of racing the host.
  vi.useFakeTimers();
  try {
    mockRunCmd.mockImplementation(slowBootPropFailure(80));

    const started = startedBootFailure(150);
    await vi.runAllTimersAsync();
    const failure = await started;

    assert.equal(failure.code, 'COMMAND_FAILED');
    assert.equal(failure.message, 'Android device did not finish booting in time');
    // The classifier sees BOOT_COMMAND_FAILED from the still-booting throw; the caller must
    // normalize it to the timeout rather than trust the raw classification.
    assert.equal(failure.details.reason, 'ANDROID_BOOT_TIMEOUT');
    assert.equal(failure.details.timeoutMs, 150);
    assert.equal(Number(failure.details.elapsedMs) >= 150, true);
    assert.equal(mockRunCmd.mock.calls.length, 2);
  } finally {
    vi.useRealTimers();
  }
});

test('a TOOL_MISSING adb inside the boot loop keeps its error code and hint', async () => {
  mockRunCmd.mockRejectedValue(new AppError('TOOL_MISSING', 'adb not found in PATH'));

  const failure = await expectBootFailure(500);

  assert.equal(failure.code, 'TOOL_MISSING');
  assert.equal(failure.message, 'adb not found in PATH');
  assert.equal(failure.details.reason, 'ADB_TRANSPORT_UNAVAILABLE');
});

test('boot failure details keep the original error details over the poll evidence', async () => {
  mockRunCmd.mockRejectedValue(
    new AppError('COMMAND_FAILED', 'error: device not found', {
      reason: 'BOOT_COMMAND_FAILED',
      diagnosticId: 'adb-x',
    }),
  );

  const failure = await expectBootFailure(500);

  assert.equal(failure.code, 'COMMAND_FAILED');
  assert.equal(failure.message, 'error: device not found');
  assert.equal(failure.details.reason, 'BOOT_COMMAND_FAILED');
  assert.equal(failure.details.diagnosticId, 'adb-x');
});
