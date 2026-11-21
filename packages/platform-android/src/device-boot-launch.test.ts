import { beforeEach, expect, test, vi } from 'vitest';
import { LIFETIME_TOKEN, STALE_LIFETIME_TOKEN } from '@agent-device/test-kit';

const mocks = vi.hoisted(() => ({
  readProcessIdentityFacts: vi.fn(),
  isProcessAlive: vi.fn(),
  waitForProcessExit: vi.fn(),
  stopProcessAndConfirmExit: vi.fn(),
}));

// `processStartTimesDiffer` stays real: the comparison it performs is the rule under test, and the
// process reads are the answers modelled here.
vi.mock('@agent-device/host-kit/process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent-device/host-kit/process')>()),
  readProcessIdentityFacts: mocks.readProcessIdentityFacts,
  isProcessAlive: mocks.isProcessAlive,
  waitForProcessExit: mocks.waitForProcessExit,
  stopProcessAndConfirmExit: mocks.stopProcessAndConfirmExit,
}));

import {
  checkAndroidEmulatorLaunchProcess,
  confirmAndroidEmulatorLaunchProcessStopped,
  readAndroidEmulatorLaunchStartTime,
  stopAndroidEmulatorLaunchProcess,
} from './device-boot.ts';

/** The identity `open` recorded for the emulator process it launched. */
const IDENTITY = { pid: 4112, startTime: LIFETIME_TOKEN } as const;

beforeEach(() => {
  vi.resetAllMocks();
  mocks.readProcessIdentityFacts.mockResolvedValue({
    startTime: IDENTITY.startTime,
    zombie: false,
  });
  mocks.isProcessAlive.mockReturnValue(true);
  mocks.waitForProcessExit.mockResolvedValue(true);
  mocks.stopProcessAndConfirmExit.mockResolvedValue({ status: 'stopped', signal: 'SIGTERM' });
});

test('reads the launch start time the process read answers with', async () => {
  expect(await readAndroidEmulatorLaunchStartTime(4242)).toBe(IDENTITY.startTime);
  expect(mocks.readProcessIdentityFacts).toHaveBeenCalledExactlyOnceWith(4242, 5_000);
});

test('a slow launch start time read is retried once with the full budget', async () => {
  mocks.readProcessIdentityFacts
    .mockRejectedValueOnce(new Error('ps timed out after 5000ms'))
    .mockResolvedValueOnce({ startTime: 'launch', zombie: false });
  expect(await readAndroidEmulatorLaunchStartTime(4242)).toBe('launch');
  expect(mocks.readProcessIdentityFacts.mock.calls).toEqual([
    [4242, 5_000],
    [4242, 5_000],
  ]);
});

test('a zombie launch has no start time and is not read again', async () => {
  mocks.readProcessIdentityFacts.mockResolvedValueOnce({ startTime: null, zombie: true });
  expect(await readAndroidEmulatorLaunchStartTime(4242)).toBeNull();
  expect(mocks.readProcessIdentityFacts).toHaveBeenCalledTimes(1);
});

test('a launch the host never answers for has no start time after both reads', async () => {
  mocks.readProcessIdentityFacts.mockResolvedValue({ startTime: null, zombie: null });
  expect(await readAndroidEmulatorLaunchStartTime(4242)).toBeNull();
  expect(mocks.readProcessIdentityFacts).toHaveBeenCalledTimes(2);
});

test('a launched process that still answers with its recorded start time is the same launch', async () => {
  expect(await checkAndroidEmulatorLaunchProcess(IDENTITY)).toBe('same');
  // One read, on the ordinary process budget: this answer is on a close's decision path.
  expect(mocks.readProcessIdentityFacts).toHaveBeenCalledExactlyOnceWith(4112, 1_000);
});

test('a launched process that is gone is a changed launch even though the serial still answers', async () => {
  mocks.isProcessAlive.mockReturnValue(false);
  expect(await checkAndroidEmulatorLaunchProcess(IDENTITY)).toBe('changed');
});

test('a zombie answering the recorded pid is a changed launch', async () => {
  mocks.readProcessIdentityFacts.mockResolvedValueOnce({
    startTime: IDENTITY.startTime,
    zombie: true,
  });
  expect(await checkAndroidEmulatorLaunchProcess(IDENTITY)).toBe('changed');
});

test('a reused pid carrying a new start time is a changed launch', async () => {
  // Quick Boot keeps the serial and the guest clock, so only the lifetime tells the two emulator
  // processes apart.
  mocks.readProcessIdentityFacts.mockResolvedValueOnce({
    startTime: STALE_LIFETIME_TOKEN,
    zombie: false,
  });
  expect(await checkAndroidEmulatorLaunchProcess(IDENTITY)).toBe('changed');
});

test('a process read that does not answer verifies nothing and stops nothing', async () => {
  mocks.readProcessIdentityFacts.mockRejectedValue(new Error('ps timed out after 1000ms'));
  expect(await checkAndroidEmulatorLaunchProcess(IDENTITY)).toBe('unverified');
});

test('a start time the host leaves blank verifies nothing rather than matching anything', async () => {
  // `processStartTimesDiffer` treats a blank as no evidence, so this must not report `same`.
  mocks.readProcessIdentityFacts.mockResolvedValueOnce({ startTime: null, zombie: false });
  expect(await checkAndroidEmulatorLaunchProcess(IDENTITY)).toBe('unverified');
});

test('a launched process that took the emulator shutdown is stopped without a signal', async () => {
  expect(await confirmAndroidEmulatorLaunchProcessStopped(IDENTITY)).toBe('stopped');
  expect(mocks.waitForProcessExit).toHaveBeenCalledExactlyOnceWith(4112, 3_000);
  expect(mocks.stopProcessAndConfirmExit).not.toHaveBeenCalled();
});

test('a launched process that ignores the emulator shutdown is stopped by its recorded identity', async () => {
  mocks.waitForProcessExit.mockResolvedValue(false);
  expect(await confirmAndroidEmulatorLaunchProcessStopped(IDENTITY)).toBe('stopped');
  // host-kit signals the pid only while the recorded start time still names it, and the escalation
  // stays brief because the graceful kill already had its own budget.
  expect(mocks.stopProcessAndConfirmExit).toHaveBeenCalledExactlyOnceWith(
    { pid: 4112, identity: { startTime: IDENTITY.startTime } },
    { termTimeoutMs: 1_500, killTimeoutMs: 1_500 },
  );
});

test('a launched process that survives every stop is reported unconfirmed', async () => {
  mocks.waitForProcessExit.mockResolvedValue(false);
  mocks.stopProcessAndConfirmExit.mockResolvedValue({
    status: 'retained',
    reason: 'exit-timeout',
    signal: 'SIGKILL',
  });
  expect(await confirmAndroidEmulatorLaunchProcessStopped(IDENTITY)).toBe('unconfirmed');
});

// #4764: an open that launched this emulator and published no session has no device to ask to shut
// down, so its cleanup addresses the process alone.
test('a launch stopped without a device shutdown is signalled by its recorded identity', async () => {
  expect(await stopAndroidEmulatorLaunchProcess(IDENTITY)).toBe('stopped');
  expect(mocks.waitForProcessExit).not.toHaveBeenCalled();
  expect(mocks.stopProcessAndConfirmExit).toHaveBeenCalledExactlyOnceWith(
    { pid: 4112, identity: { startTime: IDENTITY.startTime } },
    { termTimeoutMs: 1_500, killTimeoutMs: 1_500 },
  );
});

test('a launch that survives that stop is reported unconfirmed', async () => {
  mocks.stopProcessAndConfirmExit.mockResolvedValue({
    status: 'retained',
    reason: 'exit-timeout',
    signal: 'SIGKILL',
  });
  expect(await stopAndroidEmulatorLaunchProcess(IDENTITY)).toBe('unconfirmed');
});
