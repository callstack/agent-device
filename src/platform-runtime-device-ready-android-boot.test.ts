import { afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest';

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
import { loadAndroidMechanics } from './platform-runtime-android-mechanics.ts';

bindTestCommandHost();

const mockRunCmd = vi.mocked(runCmd);
const ensureLocalDeviceReady = createDaemonPlatformServices().ensureLocalDeviceReady;

const BOOTED = { stdout: '1\n', stderr: '', exitCode: 0 };
const STILL_BOOTING = { stdout: '', stderr: '', exitCode: 0 };

beforeAll(async () => {
  await loadAndroidMechanics();
});

beforeEach(() => {
  mockRunCmd.mockReset();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

async function runReadiness(): Promise<boolean> {
  const started = ensureLocalDeviceReady(ANDROID_EMULATOR).then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
  await vi.runAllTimersAsync();
  const result = await started;
  if ('error' in result) throw result.error;
  return result.value;
}

async function readinessFailure(): Promise<AppError> {
  const error = await runReadiness().then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(error).toBeInstanceOf(AppError);
  return error as AppError;
}

test.each(['error: device offline', 'device offline', 'error: protocol fault', 'transport error'])(
  'a retriable adb observation (%s) retries until the device reports booted',
  async (stderr) => {
    mockRunCmd.mockResolvedValueOnce({ stdout: '', stderr, exitCode: 1 });
    mockRunCmd.mockResolvedValueOnce(BOOTED);

    await expect(runReadiness()).resolves.toBe(true);

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

  await expect(runReadiness()).resolves.toBe(true);

  expect(mockRunCmd).toHaveBeenCalledTimes(3);
});

test.each(['error: device unauthorized', 'device unauthorized'])(
  'an unauthorized device (%s) fails readiness after one poll',
  async (stderr) => {
    mockRunCmd.mockResolvedValue({ stdout: '', stderr, exitCode: 1 });

    const error = await readinessFailure();

    expect(error.details).toMatchObject({
      adbFailure: 'device_unauthorized',
      reason: 'ADB_TRANSPORT_UNAVAILABLE',
    });
    expect(mockRunCmd).toHaveBeenCalledTimes(1);
  },
);

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

test('a retriable device-not-found host refusal remains terminal', async () => {
  mockRunCmd.mockResolvedValue({
    stdout: '',
    stderr: "error: device 'emulator-5554' not found",
    exitCode: 1,
  });
  const error = await readinessFailure();
  expect(error.details).toMatchObject({
    adbFailure: 'device_not_found',
    retriable: true,
    adbHostRefusal: true,
  });
  expect(mockRunCmd).toHaveBeenCalledTimes(1);
});

test('an unclassified closed adb connection remains terminal', async () => {
  mockRunCmd.mockResolvedValue({ stdout: '', stderr: 'error: closed', exitCode: 1 });
  const error = await readinessFailure();
  expect(error.details?.adbFailure).toBeUndefined();
  expect(mockRunCmd).toHaveBeenCalledTimes(1);
});
