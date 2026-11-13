import { beforeEach, expect, test, vi } from 'vitest';

// Only the process boundary is scripted. The daemon's local-readiness port, the root Android adb
// host binding, the real adb failure producer and `waitForAndroidBoot` all run unmocked.
vi.mock('@agent-device/host-kit/command', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent-device/host-kit/command')>();
  return { ...actual, runCmd: vi.fn() };
});

import { runCmd } from '@agent-device/host-kit/command';
import { AppError } from '@agent-device/kernel/errors';
import { ANDROID_EMULATOR, bindTestCommandHost } from '@agent-device/test-kit';
import { createDaemonPlatformServices } from './platform-runtime-daemon-services.ts';

bindTestCommandHost();

const mockRunCmd = vi.mocked(runCmd);
const ensureLocalDeviceReady = createDaemonPlatformServices().ensureLocalDeviceReady;

const BOOTED = { stdout: '1\n', stderr: '', exitCode: 0 };
const STILL_BOOTING = { stdout: '', stderr: '', exitCode: 0 };

beforeEach(() => {
  mockRunCmd.mockReset();
});

async function readinessFailure(): Promise<AppError> {
  const error = await ensureLocalDeviceReady(ANDROID_EMULATOR).then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(AppError);
  return error as AppError;
}

// Invariant: through the local readiness port, an adb `device offline` observation retries only
// when the real adb producer typed it `device_offline` + `retriable`, never because of host-refusal
// shape or wording alone. Production mutants: restore `adbHostRefusal === true` as the retry key
// (the plain `device offline` row stops retrying) or retry on offline wording (the stdout-only
// row starts retrying).
test.each(['error: device offline', 'device offline'])(
  'an adb offline observation (%s) retries until the device reports booted',
  async (stderr) => {
    mockRunCmd.mockResolvedValueOnce({ stdout: '', stderr, exitCode: 1 });
    mockRunCmd.mockResolvedValueOnce(BOOTED);

    await expect(ensureLocalDeviceReady(ANDROID_EMULATOR)).resolves.toBe(true);

    expect(mockRunCmd).toHaveBeenCalledTimes(2);
    const [command, args] = mockRunCmd.mock.calls[0]!;
    expect(command).toBe('adb');
    expect(args).toContain(ANDROID_EMULATOR.id);
    expect(args.join(' ')).toContain('sys.boot_completed');
  },
);

test('offline, then not yet booted, then booted resolves once the device reports booted', async () => {
  mockRunCmd.mockResolvedValueOnce({
    stdout: '',
    stderr: 'error: device offline',
    exitCode: 1,
  });
  mockRunCmd.mockResolvedValueOnce(STILL_BOOTING);
  mockRunCmd.mockResolvedValueOnce(BOOTED);

  await expect(ensureLocalDeviceReady(ANDROID_EMULATOR)).resolves.toBe(true);

  expect(mockRunCmd).toHaveBeenCalledTimes(3);
});

test('an unauthorized device fails readiness after one poll', async () => {
  mockRunCmd.mockResolvedValue({ stdout: '', stderr: 'error: device unauthorized', exitCode: 1 });

  const error = await readinessFailure();

  expect(error.details).toMatchObject({
    adbFailure: 'device_unauthorized',
    reason: 'ADB_TRANSPORT_UNAVAILABLE',
  });
  expect(mockRunCmd).toHaveBeenCalledTimes(1);
});

test('a missing adb tool fails readiness after one poll', async () => {
  mockRunCmd.mockRejectedValue(new AppError('TOOL_MISSING', 'adb not found'));

  const error = await readinessFailure();

  expect(error.code).toBe('TOOL_MISSING');
  expect(mockRunCmd).toHaveBeenCalledTimes(1);
});

// Closest negative: the same words as the retried rows, but carried on stdout where the real
// producer types no failure, so there is no typed evidence to retry on.
test('offline wording on stdout without a typed adb failure fails readiness after one poll', async () => {
  mockRunCmd.mockResolvedValue({ stdout: 'device offline', stderr: '', exitCode: 1 });

  const error = await readinessFailure();

  expect(error.details?.adbFailure).toBeUndefined();
  expect(mockRunCmd).toHaveBeenCalledTimes(1);
});
