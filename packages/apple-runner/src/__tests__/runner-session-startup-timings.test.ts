import assert from 'node:assert/strict';
import { beforeEach, test, vi } from 'vitest';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { IOS_SIMULATOR } from './device-fixtures.ts';
import { appleRunnerTestHost } from '../test-host.ts';
import {
  makeBackgroundRunner,
  makeClassifyOwnerLivenessViaMocks,
  runnerResponse,
  RUNNER_CACHE_METADATA_FIXTURE,
  RUNNER_CACHE_KEY_FIXTURE,
} from './runner-session-fixtures.ts';
import { mkdtempForTestSync } from './tmp-dir.ts';

const {
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
} = vi.hoisted(() => ({
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

import {
  abortAllIosRunnerSessions,
  ensureRunnerSession,
  executeRunnerCommandWithSession,
} from '../runner-session.ts';

const TEST_OWNER_START_TIME = 'fixed-test-owner-start-time';
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
    'agent-device-runner-lease-test-',
  );
  mockRunXcrun.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });
  mockEnsureXctestrunArtifact.mockResolvedValue({
    xctestrunPath: '/tmp/base-runner.xctestrun',
    derived: '/tmp/derived',
    cacheKey: RUNNER_CACHE_KEY_FIXTURE,
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
  mockResolveExpectedRunnerCacheMetadata.mockReturnValue(RUNNER_CACHE_METADATA_FIXTURE);
  mockResolveRunnerDerivedPath.mockReturnValue('/tmp/derived');
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

async function readStartupTimingsDiagnostic(
  device: DeviceInfo,
): Promise<{ durationMs: number; timings: Record<string, number> }> {
  let reported: { durationMs: number; timings: Record<string, number> } | undefined;
  appleRunnerTestHost.update({
    emitDiagnostic: (event) => {
      if (event.phase !== 'ios_runner_session_startup_timings') return;
      reported = {
        durationMs: event.durationMs as number,
        timings: (event.data as { timings: Record<string, number> }).timings,
      };
    },
  });
  const session = await ensureRunnerSession(device, {});
  await executeRunnerCommandWithSession(
    device,
    session,
    { command: 'snapshot', appBundleId: 'com.example.demo' },
    '/tmp/runner.log',
    30_000,
  );
  assert.ok(reported, 'expected ios_runner_session_startup_timings');
  return reported;
}

const sumValues = (timings: Record<string, number>) =>
  Object.values(timings).reduce((sum, value) => sum + value, 0);

test('runner session startup total excludes the build nested in ensure_xctestrun on a cache miss', async () => {
  mockWaitForRunner.mockResolvedValue(runnerResponse({ nodes: [], truncated: false }));

  const { durationMs, timings } = await readStartupTimingsDiagnostic({
    ...IOS_SIMULATOR,
    id: 'runner-session-timings-miss-sim',
  });

  assert.equal(timings.build_xctestrun, 12);
  assert.equal(durationMs, sumValues(timings) - 12);
});

test('runner session startup total is the plain sum of phases on a cache hit', async () => {
  mockEnsureXctestrunArtifact.mockResolvedValue({
    xctestrunPath: '/tmp/cached-runner.xctestrun',
    derived: '/tmp/derived',
    cacheKey: RUNNER_CACHE_KEY_FIXTURE,
    cache: 'hit',
    artifact: 'valid',
    buildMs: 0,
    xctestrunPathSource: 'manifest',
  });
  mockWaitForRunner.mockResolvedValue(runnerResponse({ nodes: [], truncated: false }));

  const { durationMs, timings } = await readStartupTimingsDiagnostic({
    ...IOS_SIMULATOR,
    id: 'runner-session-timings-hit-sim',
  });

  assert.equal(timings.build_xctestrun, 0);
  assert.equal(durationMs, sumValues(timings));
});
