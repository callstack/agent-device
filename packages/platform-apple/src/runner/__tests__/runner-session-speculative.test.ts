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
  // Deterministic owner identity: the real readProcessStartTime shells out to `ps` with a 1s
  // timeout that can miss under CPU contention and flip a live owner to dead.
  mockReadProcessCommand: vi.fn((_pid: number) => null as string | null),
  mockReadProcessStartTime: vi.fn((_pid: number) => 'fixed-test-owner-start-time' as string | null),
  mockResolveExpectedRunnerCacheMetadata: vi.fn(),
  mockResolveRunnerDerivedPath: vi.fn(),
  mockRunAppleToolCommand: vi.fn(),
  mockRunCmdBackground: vi.fn(),
  mockRunXcrun: vi.fn(),
  mockSendRunnerCommandOnce: vi.fn(),
  // The runner child pid is fabricated (4242): signal writes are mocked next to the liveness
  // reads so a made-up pid never reaches a sibling vitest fork (#1824).
  mockSignalPidsBestEffort: vi.fn(),
  mockSignalProcessGroupBestEffort: vi.fn(),
  mockWaitForRunner: vi.fn(),
  mockRedirectRelease: vi.fn(),
}));

vi.mock('../runner-io.ts', async () => {
  const actual = await vi.importActual<typeof import('../runner-io.ts')>('../runner-io.ts');
  return { ...actual, cleanupTempFile: mockCleanupTempFile, getFreePort: mockGetFreePort };
});

vi.mock('../runner-transport.ts', async () => {
  const actual =
    await vi.importActual<typeof import('../runner-transport.ts')>('../runner-transport.ts');
  return { ...actual, sendRunnerCommandOnce: mockSendRunnerCommandOnce };
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

import {
  abortAllIosRunnerSessions,
  ensureRunnerSession,
  getRunnerSessionSnapshot,
  markRunnerSessionServed,
  releaseSpeculativeIosRunnerSession,
} from '../runner-session.ts';
import { withRunnerCommandId } from '../runner-contract.ts';

const TEST_OWNER_START_TIME = 'fixed-test-owner-start-time';

// Split from runner-session.test.ts, which is over the test-size tripwire: the speculative
// session family (#2198: a proven observation-only plan retains no runner it did not ask for)
// answers its own domain question here with the same seam scaffolding.
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
    leaseOwnerStateDir: () => undefined,
    classifyOwnerLiveness: makeClassifyOwnerLivenessViaMocks({
      isProcessAlive: (pid) => Boolean(mockIsProcessAlive(pid)),
      readProcessStartTime: (pid) => (mockReadProcessStartTime(pid) as string | null) ?? null,
    }),
  });
  await abortAllIosRunnerSessions();
  vi.resetAllMocks();
  process.env.AGENT_DEVICE_IOS_RUNNER_LEASE_DIR = mkdtempForTestSync(
    'agent-device-runner-lease-test-',
  );
  mockRunXcrun.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });
  mockEnsureXctestrunArtifact.mockResolvedValue({
    xctestrunPath: '/tmp/base-runner.xctestrun',
    derived: '/tmp/derived',
    cache: 'hit',
    artifact: 'reused',
    buildMs: 0,
    xctestrunPathSource: 'cache',
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

test('a prewarm-started session is speculative until a command other than a readiness probe uses it', async () => {
  const device = { ...IOS_SIMULATOR, id: 'runner-session-speculative-sim' };

  const session = await ensureRunnerSession(device, { speculative: true });
  assert.equal(session.speculative, true);

  markRunnerSessionServed(session, withRunnerCommandId({ command: 'uptime' }));
  assert.equal(session.speculative, true, 'a readiness probe is not a use');

  markRunnerSessionServed(session, withRunnerCommandId({ command: 'tap', x: 1, y: 1 }));
  assert.equal(session.speculative, false);
  assert.equal(await releaseSpeculativeIosRunnerSession(device.id), false);
  assert.notEqual(getRunnerSessionSnapshot(device.id), null, 'a served runner stays');
});

test('releasing a speculative session stops it; a session a command asked for is kept', async () => {
  const speculative = { ...IOS_SIMULATOR, id: 'runner-session-speculative-release-sim' };
  const demanded = { ...IOS_SIMULATOR, id: 'runner-session-demanded-sim' };

  await ensureRunnerSession(speculative, { speculative: true });
  await ensureRunnerSession(demanded, {});

  assert.equal(await releaseSpeculativeIosRunnerSession(speculative.id), true);
  assert.equal(getRunnerSessionSnapshot(speculative.id), null);
  assert.equal(await releaseSpeculativeIosRunnerSession(demanded.id), false);
  assert.notEqual(getRunnerSessionSnapshot(demanded.id), null);
  assert.equal(await releaseSpeculativeIosRunnerSession('no-such-device'), false);
});
