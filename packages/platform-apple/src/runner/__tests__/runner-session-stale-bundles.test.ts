import assert from 'node:assert/strict';
import { beforeEach, test, vi } from 'vitest';
import { IOS_SIMULATOR } from './device-fixtures.ts';
import { appleRunnerTestHost } from '../test-host.ts';
import {
  makeBackgroundRunner,
  makeClassifyOwnerLivenessViaMocks,
  runnerResponse,
} from './runner-session-fixtures.ts';
import { mkdtempForTestSync } from './tmp-dir.ts';

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
  // Non-empty default: RUNNER_OWNER_START_TIME below is computed at module
  // load (before beforeEach), and readProcessStartTime's real implementation
  // shells out to `ps` with a 1s timeout that can miss under CPU contention,
  // flipping a live owner to 'owner-process-dead'. Deterministic value, no
  // shell-out; identity is still enforced by pid in beforeEach below.
  mockReadProcessCommand: vi.fn((_pid: number) => null as string | null),
  mockReadProcessStartTime: vi.fn((_pid: number) => 'fixed-test-owner-start-time' as string | null),
  mockResolveExpectedRunnerCacheMetadata: vi.fn(),
  mockResolveRunnerDerivedPath: vi.fn(),
  mockRunAppleToolCommand: vi.fn(),
  mockRunCmdBackground: vi.fn(),
  mockRunXcrun: vi.fn(),
  mockSendRunnerCommandOnce: vi.fn(),
  // The runner child pid below is fabricated (4242), so the signal writes are
  // mocked next to the liveness reads: a real signal to a made-up pid can hit a
  // sibling vitest fork (#1824), and the shared setup refuses it outright.
  mockSignalPidsBestEffort: vi.fn(),
  mockSignalProcessGroupBestEffort: vi.fn(),
  mockWaitForRunner: vi.fn(),
  mockRedirectRelease: vi.fn(),
}));

vi.mock('../runner-io.ts', async () => {
  const actual = await vi.importActual<typeof import('../runner-io.ts')>('../runner-io.ts');
  return {
    ...actual,
    cleanupTempFile: mockCleanupTempFile,
    getFreePort: mockGetFreePort,
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

vi.mock('../runner-startup-transport.ts', async () => {
  const actual = await vi.importActual<typeof import('../runner-startup-transport.ts')>(
    '../runner-startup-transport.ts',
  );
  return { ...actual, waitForRunner: mockWaitForRunner };
});

import { abortAllIosRunnerSessions, ensureRunnerSession } from '../runner-session.ts';
import { IOS_RUNNER_CONTAINER_BUNDLE_IDS } from '../runner-xctestrun.ts';
import { AppError } from '@agent-device/kernel/errors';

const TEST_OWNER_START_TIME = 'fixed-test-owner-start-time';
let leaseOwnerStateDirOverride: string | undefined;

// Split from runner-session.test.ts: that file is over the test-size tripwire
// and may only shrink, so the stale-bundle cleanup family answers its own
// domain question here with the same seam scaffolding.
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
    'agent-device-runner-lease-test-',
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
  // Our pid reads back its fixed start time; any other pid reads as
  // not-found, same as a real `ps` miss.
  mockReadProcessStartTime.mockImplementation((pid: number) =>
    pid === process.pid ? TEST_OWNER_START_TIME : null,
  );
  mockWaitForRunner.mockResolvedValue(runnerResponse({ uptimeMs: 1 }));
});

test('runner session keeps boot and stale bundle cleanup available when needed', async () => {
  const device = { ...IOS_SIMULATOR, id: 'runner-session-clean-sim', booted: false };

  await ensureRunnerSession(device, {
    cleanStaleBundles: true,
  });

  assert.equal(
    mockRunXcrun.mock.calls.some((call) => call[0]?.includes('bootstatus')),
    true,
  );
  assert.equal(
    mockRunXcrun.mock.calls.some((call) => call[0]?.includes('uninstall')),
    true,
  );
  const uninstallCalls = mockRunXcrun.mock.calls.filter((call) => call[0]?.includes('uninstall'));
  assert.equal(
    uninstallCalls.every((call) => call[1]?.timeoutMs === 10_000),
    true,
  );
});

test('runner session stale bundle cleanup is best-effort when simctl stalls', async () => {
  const device = { ...IOS_SIMULATOR, id: 'runner-session-clean-timeout-sim' };

  mockRunXcrun
    .mockRejectedValueOnce(new AppError('COMMAND_FAILED', 'simctl uninstall timed out'))
    .mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });

  const session = await ensureRunnerSession(device, {
    cleanStaleBundles: true,
  });

  assert.equal(session.deviceId, device.id);
  assert.equal(mockRunCmdBackground.mock.calls.length, 1);
});

test('stale bundle uninstalls start concurrently', async () => {
  const device = { ...IOS_SIMULATOR, id: 'runner-session-clean-concurrent-sim' };
  const uninstallGates: Array<
    (result: { exitCode: number; stdout: string; stderr: string }) => void
  > = [];
  mockRunXcrun.mockImplementation(async (args: string[]) => {
    if (args.includes('uninstall')) {
      return await new Promise((resolve) => {
        uninstallGates.push(resolve);
      });
    }
    return { exitCode: 0, stdout: '', stderr: '' };
  });

  const sessionPromise = ensureRunnerSession(device, { cleanStaleBundles: true });
  // Both container bundle uninstalls must be in flight before either resolves;
  // against the sequential pre-fix loop this wait times out with one gate held.
  await vi.waitFor(() =>
    assert.equal(uninstallGates.length, IOS_RUNNER_CONTAINER_BUNDLE_IDS.length),
  );
  for (const resolve of uninstallGates) {
    resolve({ exitCode: 0, stdout: '', stderr: '' });
  }
  const session = await sessionPromise;

  assert.equal(session.deviceId, device.id);
});
