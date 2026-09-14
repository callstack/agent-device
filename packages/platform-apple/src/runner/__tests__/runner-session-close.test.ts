import assert from 'node:assert/strict';
import { beforeEach, test, vi } from 'vitest';
import { IOS_SIMULATOR } from './device-fixtures.ts';
import { appleRunnerTestHost } from '../test-host.ts';
import {
  makeClassifyOwnerLivenessViaMocks,
  makeBackgroundRunner,
  makeRunnerSession,
  runnerError,
  runnerResponse,
} from './runner-session-fixtures.ts';
import { mkdtempForTestSync } from './tmp-dir.ts';

// The main-thread-occupancy half of the runner-session lifecycle: what the daemon records from a
// runner's busy signals, and what `close` does with a runner that reported abandoned main-thread
// work still draining (#2552). Split out of `runner-session.test.ts`, which already mirrors the
// rest of `runner-session.ts` and is held at the test-file size tripwire.

const {
  mockAcquireXcodebuildSimulatorSetRedirect,
  mockCleanupTempFile,
  mockEnsureXctestrunArtifact,
  mockGetFreePort,
  mockIsProcessAlive,
  mockIsProcessGroupAlive,
  mockPrepareXctestrunWithEnv,
  mockReadProcessCommand,
  mockReadProcessStartTime,
  mockResolveExpectedRunnerCacheMetadata,
  mockResolveRunnerDerivedPath,
  mockRunAppleToolCommand,
  mockRunCmdBackground,
  mockRunXcrun,
  mockSendRunnerCommandOnce,
  mockSignalPidsBestEffort,
  mockSignalProcessGroupBestEffort,
  mockWaitForRunner,
  mockRedirectRelease,
} = vi.hoisted(() => ({
  mockAcquireXcodebuildSimulatorSetRedirect: vi.fn(),
  mockCleanupTempFile: vi.fn(),
  mockEnsureXctestrunArtifact: vi.fn(),
  mockGetFreePort: vi.fn(),
  mockIsProcessAlive: vi.fn(),
  mockIsProcessGroupAlive: vi.fn(),
  mockPrepareXctestrunWithEnv: vi.fn(),
  mockReadProcessCommand: vi.fn((_pid: number) => null as string | null),
  mockReadProcessStartTime: vi.fn((_pid: number) => 'fixed-test-owner-start-time' as string | null),
  mockResolveExpectedRunnerCacheMetadata: vi.fn(),
  mockResolveRunnerDerivedPath: vi.fn(),
  mockRunAppleToolCommand: vi.fn(),
  mockRunCmdBackground: vi.fn(),
  mockRunXcrun: vi.fn(),
  mockSendRunnerCommandOnce: vi.fn(),
  mockSignalPidsBestEffort: vi.fn(),
  mockSignalProcessGroupBestEffort: vi.fn(),
  mockWaitForRunner: vi.fn(),
  mockRedirectRelease: vi.fn(),
}));

const TEST_OWNER_START_TIME = 'fixed-test-owner-start-time';

vi.mock('../runner-io.ts', async () => {
  const actual = await vi.importActual<typeof import('../runner-io.ts')>('../runner-io.ts');
  return {
    ...actual,
    cleanupTempFile: mockCleanupTempFile,
    getFreePort: mockGetFreePort,
  };
});

vi.mock('../runner-startup-transport.ts', async () => {
  const actual = await vi.importActual<typeof import('../runner-startup-transport.ts')>(
    '../runner-startup-transport.ts',
  );
  return {
    ...actual,
    waitForRunner: mockWaitForRunner,
  };
});

vi.mock('../runner-transport.ts', async () => {
  const actual =
    await vi.importActual<typeof import('../runner-transport.ts')>('../runner-transport.ts');
  return {
    ...actual,
    sendRunnerCommandOnce: mockSendRunnerCommandOnce,
  };
});

vi.mock('../runner-xctestrun.ts', async () => {
  const actual =
    await vi.importActual<typeof import('../runner-xctestrun.ts')>('../runner-xctestrun.ts');
  return {
    ...actual,
    acquireXcodebuildSimulatorSetRedirect: mockAcquireXcodebuildSimulatorSetRedirect,
    ensureXctestrunArtifact: mockEnsureXctestrunArtifact,
    prepareXctestrunWithEnv: mockPrepareXctestrunWithEnv,
    resolveExpectedRunnerCacheMetadata: mockResolveExpectedRunnerCacheMetadata,
    resolveRunnerDerivedPath: mockResolveRunnerDerivedPath,
  };
});

import {
  abortAllIosRunnerSessions,
  cancelIosRunnerIdleStop,
  ensureRunnerSession,
  scheduleIosRunnerIdleStop,
  executeRunnerCommandWithSession,
  getRunnerSessionSnapshot,
} from '../runner-session.ts';

// Test-only stand-in for the daemon's runtime lease-owner-state-dir setter (root-only; the package
// cannot import it). Backs the host.leaseOwnerStateDir() getter the package reads instead.
let leaseOwnerStateDirOverride: string | undefined;

beforeEach(async () => {
  appleRunnerTestHost.update({
    runCmdBackground: mockRunCmdBackground,
    isProcessAlive: mockIsProcessAlive,
    isProcessGroupAlive: mockIsProcessGroupAlive,
    readProcessCommand: mockReadProcessCommand,
    readProcessStartTime: mockReadProcessStartTime,
    signalPidsBestEffort: mockSignalPidsBestEffort,
    signalProcessGroupBestEffort: mockSignalProcessGroupBestEffort,
    runAppleToolCommand: mockRunAppleToolCommand,
    runXcrun: mockRunXcrun,
    leaseOwnerStateDir: () => leaseOwnerStateDirOverride,
    classifyOwnerLiveness: makeClassifyOwnerLivenessViaMocks({
      isProcessAlive: (pid) => Boolean(mockIsProcessAlive(pid)),
      readProcessStartTime: (pid) => (mockReadProcessStartTime(pid) as string | null) ?? null,
    }),
  });
  await abortAllIosRunnerSessions();
  vi.resetAllMocks();
  leaseOwnerStateDirOverride = undefined;
  process.env.AGENT_DEVICE_IOS_RUNNER_LEASE_DIR = mkdtempForTestSync(
    'agent-device-runner-close-test-',
  );
  mockRunXcrun.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });
  mockEnsureXctestrunArtifact.mockResolvedValue({
    xctestrunPath: '/tmp/base-runner.xctestrun',
    derived: '/tmp/derived',
    cache: 'miss',
    artifact: 'rebuilt',
    buildMs: 12,
    xctestrunPathSource: 'build',
  });
  mockGetFreePort.mockResolvedValue(8123);
  mockPrepareXctestrunWithEnv.mockResolvedValue({
    xctestrunPath: '/tmp/session-runner.xctestrun',
    jsonPath: '/tmp/session-runner.json',
  });
  mockResolveExpectedRunnerCacheMetadata.mockReturnValue({ schemaVersion: 1 });
  mockResolveRunnerDerivedPath.mockReturnValue('/tmp/derived');
  mockAcquireXcodebuildSimulatorSetRedirect.mockResolvedValue({ release: mockRedirectRelease });
  mockRunCmdBackground.mockReturnValue(makeBackgroundRunner(4242));
  mockRunAppleToolCommand.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });
  mockIsProcessAlive.mockReturnValue(true);
  mockIsProcessGroupAlive.mockReturnValue(false);
  mockReadProcessCommand.mockReturnValue(null);
  mockReadProcessStartTime.mockImplementation((pid: number) =>
    pid === process.pid ? TEST_OWNER_START_TIME : null,
  );
  mockWaitForRunner.mockResolvedValue(runnerResponse({ uptimeMs: 1 }));
});

async function waitForRunnerSessionGone(deviceId: string): Promise<boolean> {
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    if (getRunnerSessionSnapshot(deviceId) === null) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return getRunnerSessionSnapshot(deviceId) === null;
}

test('a RUNNER_BUSY refusal records the runner as still draining main-thread work', async () => {
  const session = makeRunnerSession({ ready: true });
  mockWaitForRunner.mockResolvedValueOnce(runnerResponse({ uptimeMs: 42 }));
  mockSendRunnerCommandOnce.mockResolvedValueOnce(
    runnerError({
      code: 'RUNNER_BUSY',
      message: 'The iOS runner is still finishing a previous command that exceeded its watchdog',
    }),
  );

  await assert.rejects(() =>
    executeRunnerCommandWithSession(
      IOS_SIMULATOR,
      session,
      { command: 'tap', x: 120, y: 240, appBundleId: 'com.example.demo' },
      '/tmp/runner.log',
      30_000,
    ),
  );

  assert.equal(session.runnerMainThreadBusy, true);
});

test('a healthy response stamped with busy main-thread work keeps the session marked busy', async () => {
  const session = makeRunnerSession({ ready: true });
  mockWaitForRunner.mockResolvedValueOnce(runnerResponse({ uptimeMs: 42 }));
  mockSendRunnerCommandOnce.mockResolvedValueOnce(
    runnerResponse({ tapped: true, runnerMainThreadBusy: true }),
  );

  await executeRunnerCommandWithSession(
    IOS_SIMULATOR,
    session,
    { command: 'tap', x: 120, y: 240, appBundleId: 'com.example.demo' },
    '/tmp/runner.log',
    30_000,
  );
  assert.equal(session.runnerMainThreadBusy, true);

  mockWaitForRunner.mockResolvedValueOnce(runnerResponse({ uptimeMs: 43 }));
  mockSendRunnerCommandOnce.mockResolvedValueOnce(
    runnerResponse({ tapped: true, runnerMainThreadBusy: false }),
  );
  await executeRunnerCommandWithSession(
    IOS_SIMULATOR,
    session,
    { command: 'tap', x: 130, y: 250, appBundleId: 'com.example.demo' },
    '/tmp/runner.log',
    30_000,
  );
  assert.equal(session.runnerMainThreadBusy, false);
});

test('an unstamped healthy response leaves a busy main-thread report intact', async () => {
  // Recovered and journal-replayed responses are written without the occupancy stamp; their
  // absence must not be read as "the runner drained" (#2552).
  const session = makeRunnerSession({ ready: true, runnerMainThreadBusy: true });
  mockWaitForRunner.mockResolvedValueOnce(runnerResponse({ uptimeMs: 42 }));
  mockSendRunnerCommandOnce.mockResolvedValueOnce(runnerResponse({ tapped: true }));

  await executeRunnerCommandWithSession(
    IOS_SIMULATOR,
    session,
    { command: 'tap', x: 120, y: 240, appBundleId: 'com.example.demo' },
    '/tmp/runner.log',
    30_000,
  );

  assert.equal(session.runnerMainThreadBusy, true);
});

test('close disposes a runner still draining main-thread work instead of pooling it for reopen (#2552)', async () => {
  const device = { ...IOS_SIMULATOR, id: 'runner-session-close-busy-sim' };
  const previousIdleMs = process.env.AGENT_DEVICE_IOS_RUNNER_IDLE_STOP_MS;
  // A long idle window proves the teardown below is the busy-dispose branch, not the idle timer.
  process.env.AGENT_DEVICE_IOS_RUNNER_IDLE_STOP_MS = '300000';
  try {
    const session = await ensureRunnerSession(device, {});
    session.runnerMainThreadBusy = true;

    scheduleIosRunnerIdleStop(device.id);

    assert.ok(await waitForRunnerSessionGone(device.id));
  } finally {
    cancelIosRunnerIdleStop(device.id);
    if (previousIdleMs === undefined) delete process.env.AGENT_DEVICE_IOS_RUNNER_IDLE_STOP_MS;
    else process.env.AGENT_DEVICE_IOS_RUNNER_IDLE_STOP_MS = previousIdleMs;
  }
});

test('close retains an idle runner that never reported busy main-thread work', async () => {
  const device = { ...IOS_SIMULATOR, id: 'runner-session-close-idle-sim' };
  const previousIdleMs = process.env.AGENT_DEVICE_IOS_RUNNER_IDLE_STOP_MS;
  process.env.AGENT_DEVICE_IOS_RUNNER_IDLE_STOP_MS = '300000';
  try {
    await ensureRunnerSession(device, {});

    scheduleIosRunnerIdleStop(device.id);

    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.ok(getRunnerSessionSnapshot(device.id));
  } finally {
    cancelIosRunnerIdleStop(device.id);
    if (previousIdleMs === undefined) delete process.env.AGENT_DEVICE_IOS_RUNNER_IDLE_STOP_MS;
    else process.env.AGENT_DEVICE_IOS_RUNNER_IDLE_STOP_MS = previousIdleMs;
  }
});
