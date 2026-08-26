import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { IOS_SIMULATOR, MACOS_DEVICE, TVOS_SIMULATOR } from './device-fixtures.ts';
import type { ExecResult } from '../host.ts';
import type { RunnerSession } from '../runner-session-types.ts';
import { appleRunnerTestHost } from '../test-host.ts';

const { mockCleanupTempFile } = vi.hoisted(() => ({
  mockCleanupTempFile: vi.fn(),
}));

vi.mock('../runner-io.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../runner-io.ts')>();
  return { ...actual, cleanupTempFile: mockCleanupTempFile };
});

import { abortRunnerSessionsAndPrepProcesses } from '../runner-disposal.ts';

const mockIsProcessAlive = vi.fn();
const mockIsProcessGroupAlive = vi.fn();
const mockRunAppleToolCommand = vi.fn();
const mockRunXcrun = vi.fn();
const mockSignalPidsBestEffort = vi.fn();
const mockSignalProcessGroupBestEffort = vi.fn();

beforeEach(() => {
  appleRunnerTestHost.update({
    isProcessAlive: mockIsProcessAlive,
    isProcessGroupAlive: mockIsProcessGroupAlive,
    signalPidsBestEffort: mockSignalPidsBestEffort,
    signalProcessGroupBestEffort: mockSignalProcessGroupBestEffort,
    runAppleToolCommand: mockRunAppleToolCommand,
    runXcrun: mockRunXcrun,
  });
  vi.useFakeTimers();
  mockIsProcessAlive.mockReturnValue(true);
  mockIsProcessGroupAlive.mockReturnValue(false);
  mockRunAppleToolCommand.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });
  mockRunXcrun.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.resetAllMocks();
});

test('macOS runner abort waits for XCTest teardown after SIGINT', async () => {
  const testRun = deferred<ExecResult>();
  const session = makeRunnerSession(MACOS_DEVICE, testRun.promise);

  const abort = abortRunnerSessionsAndPrepProcesses([session]);
  await vi.advanceTimersByTimeAsync(0);

  expect(runnerSignals(session)).toEqual(['SIGINT']);

  mockIsProcessAlive.mockReturnValue(false);
  testRun.resolve(execResult());
  await abort;

  expect(runnerSignals(session)).toEqual(['SIGINT']);
  expect(mockCleanupTempFile).toHaveBeenCalledWith(session.xctestrunPath);
  expect(mockCleanupTempFile).toHaveBeenCalledWith(session.jsonPath);
});

test('macOS runner abort stages TERM after the interrupt grace period', async () => {
  const testRun = deferred<ExecResult>();
  const session = makeRunnerSession(MACOS_DEVICE, testRun.promise);

  const abort = abortRunnerSessionsAndPrepProcesses([session]);
  await vi.advanceTimersByTimeAsync(4_999);
  expect(runnerSignals(session)).toEqual(['SIGINT']);

  await vi.advanceTimersByTimeAsync(1);
  expect(runnerSignals(session)).toEqual(['SIGINT', 'SIGTERM']);

  mockIsProcessAlive.mockReturnValue(false);
  testRun.resolve(execResult());
  await abort;

  expect(runnerSignals(session)).toEqual(['SIGINT', 'SIGTERM']);
});

test('macOS runner abort force-kills only after both grace periods expire', async () => {
  const session = makeRunnerSession(MACOS_DEVICE, new Promise<ExecResult>(() => {}));

  const abort = abortRunnerSessionsAndPrepProcesses([session]);
  await vi.advanceTimersByTimeAsync(5_000);
  expect(runnerSignals(session)).toEqual(['SIGINT', 'SIGTERM']);

  await vi.advanceTimersByTimeAsync(1_999);
  expect(runnerSignals(session)).toEqual(['SIGINT', 'SIGTERM']);

  await vi.advanceTimersByTimeAsync(1);
  await abort;
  expect(runnerSignals(session)).toEqual(['SIGINT', 'SIGTERM', 'SIGKILL']);
});

test.each([IOS_SIMULATOR, TVOS_SIMULATOR])(
  '$appleOs runner abort preserves immediate cancellation',
  async (device) => {
    const session = makeRunnerSession(device, new Promise<ExecResult>(() => {}));

    await abortRunnerSessionsAndPrepProcesses([session]);

    expect(runnerSignals(session)).toEqual(['SIGINT', 'SIGTERM', 'SIGKILL']);
  },
);

function makeRunnerSession(
  device: RunnerSession['device'],
  testPromise: Promise<ExecResult>,
): RunnerSession {
  return {
    sessionId: `${device.id}:8123:test`,
    device,
    deviceId: device.id,
    port: 8123,
    xctestrunPath: `/tmp/${device.id}.xctestrun`,
    jsonPath: `/tmp/${device.id}.json`,
    testPromise,
    child: { pid: 42, exitCode: null },
    ready: true,
  };
}

function runnerSignals(session: RunnerSession): NodeJS.Signals[] {
  return mockSignalProcessGroupBestEffort.mock.calls
    .filter(([pid]) => pid === session.child.pid)
    .map(([, signal]) => signal as NodeJS.Signals);
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function execResult(): ExecResult {
  return { exitCode: 0, stdout: '', stderr: '' };
}
