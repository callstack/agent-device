import assert from 'node:assert/strict';
import { beforeEach, test, vi } from 'vitest';
import type { DeviceInfo } from '@agent-device/kernel/device';

vi.mock('../../../utils/exec.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../utils/exec.ts')>();
  return {
    ...actual,
    runCmd: vi.fn(),
    runCmdDetached: vi.fn(),
    whichCmd: vi.fn(),
  };
});
vi.mock('../sdk.ts', () => ({ ensureAndroidSdkPathConfigured: vi.fn(async () => {}) }));

import { runCmd, runCmdDetached, whichCmd } from '../../../utils/exec.ts';
import { ensureAndroidEmulatorBooted } from '../emulator-lifecycle.ts';

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
