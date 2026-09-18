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
  redirectHandle,
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
  ensureRunnerSession,
  executeRunnerCommandWithSession,
  readRunnerSessionLiveness,
  releaseIosRunnerOnClose,
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
  mockAcquireXcodebuildSimulatorSetRedirect.mockResolvedValue(redirectHandle);
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

test('a RUNNER_BUSY refusal records the runner as still draining main-thread work', async () => {
  const session = makeRunnerSession({ state: 'ready' });
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
  const session = makeRunnerSession({ state: 'ready' });
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
  const session = makeRunnerSession({ state: 'ready', runnerMainThreadBusy: true });
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

test("the stalling command's MAIN_THREAD_TIMEOUT error records the runner as busy", async () => {
  // The direct #2552 repro: the command that stalls answers with the watchdog timeout, not
  // RUNNER_BUSY, so this is the only occupancy signal available before any refusal.
  const session = makeRunnerSession({ state: 'ready' });
  // A read-only snapshot on a ready session answers over the startup transport (uptime preflight,
  // then the command), both via waitForRunner.
  mockWaitForRunner
    .mockResolvedValueOnce(runnerResponse({ uptimeMs: 42 }))
    .mockResolvedValueOnce(
      runnerError({ code: 'MAIN_THREAD_TIMEOUT', message: 'main thread execution timed out' }),
    );

  await assert.rejects(() =>
    executeRunnerCommandWithSession(
      IOS_SIMULATOR,
      session,
      { command: 'snapshot', appBundleId: 'com.example.demo' },
      '/tmp/runner.log',
      30_000,
    ),
  );

  assert.equal(session.runnerMainThreadBusy, true);
});

test('a served non-busy error clears a stale busy report so close keeps a drained runner', async () => {
  // After the abandoned work drains, a later failure that reached the main thread (element not
  // found) proves it drained; leaving the flag set would make close kill a healthy runner (#2552).
  const session = makeRunnerSession({ state: 'ready', runnerMainThreadBusy: true });
  mockWaitForRunner.mockResolvedValueOnce(runnerResponse({ uptimeMs: 42 }));
  mockSendRunnerCommandOnce.mockResolvedValueOnce(
    runnerError({ code: 'ELEMENT_NOT_FOUND', message: 'element not found' }),
  );

  await assert.rejects(() =>
    executeRunnerCommandWithSession(
      IOS_SIMULATOR,
      session,
      {
        command: 'tap',
        selectorKey: 'label',
        selectorValue: 'Gone',
        appBundleId: 'com.example.demo',
      },
      '/tmp/runner.log',
      30_000,
    ),
  );

  assert.equal(session.runnerMainThreadBusy, false);
});

test('releaseIosRunnerOnClose retains an idle runner, disposes a busy one, and the reopen boots fresh (#2552)', async () => {
  const device = { ...IOS_SIMULATOR, id: 'runner-session-release-on-close-sim' };
  const session = await ensureRunnerSession(device, {});

  // Idle + retain: warm reuse, same session comes back for the next open.
  await releaseIosRunnerOnClose(device.id, { retain: true });
  assert.ok(readRunnerSessionLiveness(device.id));
  assert.equal((await ensureRunnerSession(device, {})).sessionId, session.sessionId);

  // Busy + retain: a command that stalls answers MAIN_THREAD_TIMEOUT, so the stalled runner is
  // disposed and the next open boots a clean one.
  // The session has not served a command yet, so the read-only snapshot answers over the startup
  // transport with no preflight.
  mockWaitForRunner.mockResolvedValueOnce(
    runnerError({ code: 'MAIN_THREAD_TIMEOUT', message: 'main thread execution timed out' }),
  );
  await assert.rejects(() =>
    executeRunnerCommandWithSession(
      device,
      session,
      { command: 'snapshot', appBundleId: 'com.example.demo' },
      '/tmp/runner.log',
      30_000,
    ),
  );
  await releaseIosRunnerOnClose(device.id, { retain: true });
  assert.equal(readRunnerSessionLiveness(device.id), null);
  assert.notEqual((await ensureRunnerSession(device, {})).sessionId, session.sessionId);

  // Non-retained close: stops regardless of occupancy.
  await releaseIosRunnerOnClose(device.id, { retain: false });
  assert.equal(readRunnerSessionLiveness(device.id), null);
});
