import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { IOS_SIMULATOR, MACOS_DEVICE, TVOS_SIMULATOR } from './device-fixtures.ts';
import type { ExecResult } from '../host.ts';
import type { RunnerSession } from '../runner-session-types.ts';
import { appleRunnerTestHost } from '../test-host.ts';
import { makeRunnerLease } from './runner-session-fixtures.ts';
import { mkdtempForTestSync } from './tmp-dir.ts';

const { mockCleanupTempFile } = vi.hoisted(() => ({
  mockCleanupTempFile: vi.fn(),
}));

vi.mock('../runner-io.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../runner-io.ts')>();
  return { ...actual, cleanupTempFile: mockCleanupTempFile };
});

import { abortRunnerSessionsAndPrepProcesses, disposeRunnerSession } from '../runner-disposal.ts';
import {
  currentRunnerLeaseOwnerToken,
  releaseRunnerLease,
  withRunnerLeaseLock,
  writeRunnerLease,
} from '../runner-lease.ts';

const mockIsProcessAlive = vi.fn();
const mockIsProcessGroupAlive = vi.fn();
const mockRunAppleToolCommand = vi.fn();
const mockRunXcrun = vi.fn();
const mockSignalPidsBestEffort = vi.fn();
const mockSignalProcessGroupBestEffort = vi.fn();

beforeEach(() => {
  process.env.AGENT_DEVICE_IOS_RUNNER_LEASE_DIR = mkdtempForTestSync(
    'agent-device-runner-disposal-test-',
  );
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

test('simulator disposal terminates runner container apps while it still owns the on-disk lease', async () => {
  vi.useRealTimers();
  mockIsProcessAlive.mockReturnValue(false);
  const lease = makeRunnerLease({ deviceId: IOS_SIMULATOR.id, ownerToken: 'owner-disposal-own' });
  const session = makeRunnerSession(IOS_SIMULATOR, Promise.resolve(execResult()), { lease });
  writeRunnerLease(lease);

  await disposeRunnerSession(session, { graceful: false, waitTimeoutMs: 1 });

  expect(simulatorTerminateCalls()).not.toEqual([]);
});

test('simulator disposal skips container-app termination after a foreign takeover replaced the lease', async () => {
  vi.useRealTimers();
  mockIsProcessAlive.mockReturnValue(false);
  const session = makeRunnerSession(IOS_SIMULATOR, Promise.resolve(execResult()), {
    lease: makeRunnerLease({ deviceId: IOS_SIMULATOR.id, ownerToken: 'owner-disposal-loser' }),
  });
  // The successor's runner lives in the same container bundles on the shared
  // simulator; terminating them here would stop the new owner's runner.
  writeRunnerLease(
    makeRunnerLease({ deviceId: IOS_SIMULATOR.id, ownerToken: 'owner-disposal-successor' }),
  );

  await disposeRunnerSession(session, { graceful: false, waitTimeoutMs: 1 });

  expect(simulatorTerminateCalls()).toEqual([]);
  expect(mockCleanupTempFile).toHaveBeenCalledWith(session.xctestrunPath);
});

test('disposal serializes behind a successor reclaim window and never terminates its runner', async () => {
  vi.useRealTimers();
  mockIsProcessAlive.mockReturnValue(false);
  const loserLease = makeRunnerLease({
    deviceId: IOS_SIMULATOR.id,
    ownerToken: 'owner-toctou-loser',
  });
  const session = makeRunnerSession(IOS_SIMULATOR, Promise.resolve(execResult()), {
    lease: loserLease,
  });
  writeRunnerLease(loserLease);

  let disposal: Promise<void> | undefined;
  let disposalSettled = false;
  await withRunnerLeaseLock(IOS_SIMULATOR.id, async () => {
    // The successor's critical section: loser disposal starting now must not
    // pass its ownership check inside this window — the on-disk lease still
    // names the loser, but the takeover below is already in flight.
    disposal = disposeRunnerSession(session, { graceful: false, waitTimeoutMs: 1 }).then(() => {
      disposalSettled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(disposalSettled).toBe(false);
    expect(simulatorTerminateCalls()).toEqual([]);
    releaseRunnerLease(loserLease);
    writeRunnerLease(
      makeRunnerLease({ deviceId: IOS_SIMULATOR.id, ownerToken: 'owner-toctou-successor' }),
    );
  });
  await disposal;

  expect(simulatorTerminateCalls()).toEqual([]);
  expect(currentRunnerLeaseOwnerToken(IOS_SIMULATOR.id)).toBe('owner-toctou-successor');
});

function simulatorTerminateCalls(): unknown[] {
  return mockRunXcrun.mock.calls.filter(([args]) => (args as string[]).includes('terminate'));
}

function makeRunnerSession(
  device: RunnerSession['device'],
  testPromise: Promise<ExecResult>,
  overrides: Partial<RunnerSession> = {},
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
    ...overrides,
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
