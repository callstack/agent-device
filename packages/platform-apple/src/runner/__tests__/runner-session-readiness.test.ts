import assert from 'node:assert/strict';
import fs from 'node:fs';
import { beforeEach, test, vi } from 'vitest';
import { IOS_DEVICE, IOS_SIMULATOR } from './device-fixtures.ts';
import { appleRunnerTestHost } from '../test-host.ts';
import { AppError } from '@agent-device/kernel/errors';
import {
  makeClassifyOwnerLivenessViaMocks,
  assertRunnerCommand,
  captureDiagnostics,
  makeBackgroundRunner,
  makeRunnerSession,
  runnerError,
  runnerResponse,
} from './runner-session-fixtures.ts';
import { mkdtempForTestSync } from './tmp-dir.ts';
import { createLocalAppleToolProvider, withAppleToolProvider } from '../../core/tool-provider.ts';
import { IOS_DEVICE_DEVELOPER_DISK_IMAGE_HINT } from '../../core/devicectl.ts';

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
  // Non-empty default: TEST_OWNER_START_TIME below feeds both this mock and
  // runnerOwnerStartTime()'s first (memoized) call - see the beforeEach
  // wiring and R8 in the conversion guide. readProcessStartTime's real
  // implementation shells out to `ps` with a 1s timeout that can miss under
  // CPU contention, flipping a live owner to 'owner-process-dead'.
  // Deterministic value, no shell-out; identity is still enforced by pid in
  // beforeEach below.
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

// Fixed owner-identity value shared by the readProcessStartTime override
// below and every fixture/assertion that used to read the module-load-time
// RUNNER_OWNER_START_TIME constant. runnerOwnerStartTime() (R8) memoizes on
// its first call, which reads this same override, so the two stay
// consistent without either one calling back into the other.
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
} from '../runner-session.ts';

// Test-only stand-in for the daemon's own runtime lease-owner-state-dir
// setter (root-only; the package cannot import it - R11). Backs the
// host.leaseOwnerStateDir() getter the package reads instead (R3).
let leaseOwnerStateDirOverride: string | undefined;
function setRunnerLeaseOwnerStateDir(stateDir: string | undefined): void {
  leaseOwnerStateDirOverride = stateDir;
}

beforeEach(async () => {
  // Must run before abortAllIosRunnerSessions() below: that call can tear
  // down sessions left in memory by the PREVIOUS test, and its cleanup path
  // signals real processes (host.signalPidsBestEffort et al.) unless the
  // host overrides are already installed. The setup file's own beforeEach
  // (which runs before this one) just wiped them back to real defaults.
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
  setRunnerLeaseOwnerStateDir(undefined);
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
  mockRunCmdBackground.mockReturnValue(makeBackgroundRunner(4242));
  mockRunAppleToolCommand.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });
  mockIsProcessAlive.mockReturnValue(true);
  mockIsProcessGroupAlive.mockReturnValue(false);
  mockReadProcessCommand.mockReturnValue(null);
  // Our pid reads back its fixed start time; any other pid reads as
  // not-found, same as a real `ps` miss. Dead-lease tests use fabricated
  // pids already rejected by mockIsProcessAlive before this is consulted.
  mockReadProcessStartTime.mockImplementation((pid: number) =>
    pid === process.pid ? TEST_OWNER_START_TIME : null,
  );
  mockWaitForRunner.mockResolvedValue(runnerResponse({ uptimeMs: 1 }));
});
test('runner session executes read-only commands without uptime preflight', async () => {
  const session = makeRunnerSession({ state: 'starting' });
  mockWaitForRunner.mockResolvedValueOnce(runnerResponse({ nodes: [], truncated: false }));

  const result = await executeRunnerCommandWithSession(
    IOS_SIMULATOR,
    session,
    { command: 'snapshot', appBundleId: 'com.example.demo' },
    '/tmp/runner.log',
    30_000,
  );

  assert.deepEqual(result, { nodes: [], truncated: false });
  assert.equal(session.state, 'ready');
  assert.equal(mockWaitForRunner.mock.calls.length, 1);
  assertRunnerCommand(mockWaitForRunner.mock.calls[0]?.[2], {
    command: 'snapshot',
    appBundleId: 'com.example.demo',
  });
  assert.equal(mockSendRunnerCommandOnce.mock.calls.length, 0);
});

test('runner session probes readiness before ready read-only commands', async () => {
  const session = makeRunnerSession({ state: 'ready' });
  mockWaitForRunner
    .mockResolvedValueOnce(runnerResponse({ uptimeMs: 42 }))
    .mockResolvedValueOnce(runnerResponse({ nodes: [], truncated: false }));

  const result = await executeRunnerCommandWithSession(
    IOS_SIMULATOR,
    session,
    { command: 'snapshot', appBundleId: 'com.example.demo' },
    '/tmp/runner.log',
    30_000,
  );

  assert.deepEqual(result, { nodes: [], truncated: false });
  assert.equal(mockWaitForRunner.mock.calls.length, 2);
  assertRunnerCommand(mockWaitForRunner.mock.calls[0]?.[2], { command: 'uptime' });
  assert.equal(mockWaitForRunner.mock.calls[0]?.[4], 1_000);
  assertRunnerCommand(mockWaitForRunner.mock.calls[1]?.[2], {
    command: 'snapshot',
    appBundleId: 'com.example.demo',
  });
  assert.equal(mockSendRunnerCommandOnce.mock.calls.length, 0);
});

test('runner session marks read-only readiness preflight failures before command send', async () => {
  const session = makeRunnerSession({ state: 'ready' });
  mockWaitForRunner.mockRejectedValueOnce(new Error('fetch failed'));

  await assert.rejects(
    () =>
      executeRunnerCommandWithSession(
        IOS_SIMULATOR,
        session,
        { command: 'snapshot', appBundleId: 'com.example.demo' },
        '/tmp/runner.log',
        30_000,
      ),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.details?.runnerReadinessPreflightFailed, true);
      return true;
    },
  );

  assert.equal(mockWaitForRunner.mock.calls.length, 1);
  assertRunnerCommand(mockWaitForRunner.mock.calls[0]?.[2], { command: 'uptime' });
  assert.equal(mockSendRunnerCommandOnce.mock.calls.length, 0);
});

test('runner session executes status command as read-only lifecycle command', async () => {
  const session = makeRunnerSession({ state: 'ready' });
  mockWaitForRunner.mockResolvedValueOnce(
    runnerResponse({
      commandId: 'runner-command-1',
      lifecycleState: 'completed',
      lifecycleResponseOk: true,
    }),
  );

  const result = await executeRunnerCommandWithSession(
    IOS_SIMULATOR,
    session,
    { command: 'status', statusCommandId: 'runner-command-1' },
    '/tmp/runner.log',
    30_000,
  );

  assert.deepEqual(result, {
    commandId: 'runner-command-1',
    lifecycleState: 'completed',
    lifecycleResponseOk: true,
  });
  assert.equal(mockWaitForRunner.mock.calls.length, 1);
  assertRunnerCommand(
    mockWaitForRunner.mock.calls[0]?.[2],
    {
      command: 'status',
      statusCommandId: 'runner-command-1',
    },
    { commandId: false },
  );
  assert.equal(mockSendRunnerCommandOnce.mock.calls.length, 0);
});

test('runner session probes readiness before mutating commands', async () => {
  const session = makeRunnerSession({ state: 'starting' });
  mockWaitForRunner.mockResolvedValueOnce(runnerResponse({ uptimeMs: 42 }));
  mockSendRunnerCommandOnce.mockResolvedValueOnce(runnerResponse({ tapped: true }));

  const result = await executeRunnerCommandWithSession(
    IOS_SIMULATOR,
    session,
    { command: 'tap', x: 120, y: 240, appBundleId: 'com.example.demo' },
    '/tmp/runner.log',
    30_000,
  );

  assert.deepEqual(result, { tapped: true });
  assert.equal(session.state, 'ready');
  assert.equal(mockWaitForRunner.mock.calls.length, 1);
  assertRunnerCommand(mockWaitForRunner.mock.calls[0]?.[2], { command: 'uptime' });
  assert.equal(mockSendRunnerCommandOnce.mock.calls.length, 1);
  assertRunnerCommand(mockSendRunnerCommandOnce.mock.calls[0]?.[2], {
    command: 'tap',
    x: 120,
    y: 240,
    appBundleId: 'com.example.demo',
  });
});

test('runner session emits reason diagnostics when readiness preflight is used', async () => {
  const session = makeRunnerSession({ state: 'starting' });
  mockWaitForRunner.mockResolvedValueOnce(runnerResponse({ uptimeMs: 42 }));
  mockSendRunnerCommandOnce.mockResolvedValueOnce(runnerResponse({ tapped: true }));

  const diagnostics = await captureDiagnostics(async () => {
    await executeRunnerCommandWithSession(
      IOS_SIMULATOR,
      session,
      { command: 'tap', x: 120, y: 240, appBundleId: 'com.example.demo' },
      '/tmp/runner.log',
      30_000,
    );
  });

  assert.match(diagnostics, /"reason":"startup"/);
  assert.match(diagnostics, /ios_runner_readiness_preflight/);
});

test('runner session probes readiness for ready tap commands', async () => {
  const session = makeRunnerSession({ state: 'ready' });
  mockWaitForRunner.mockResolvedValueOnce(runnerResponse({ uptimeMs: 42 }));
  mockSendRunnerCommandOnce.mockResolvedValueOnce(runnerResponse({ tapped: true }));

  const result = await executeRunnerCommandWithSession(
    IOS_SIMULATOR,
    session,
    { command: 'tap', x: 120, y: 240, appBundleId: 'com.example.demo' },
    '/tmp/runner.log',
    30_000,
  );

  assert.deepEqual(result, { tapped: true });
  assert.equal(mockWaitForRunner.mock.calls.length, 1);
  assertRunnerCommand(mockWaitForRunner.mock.calls[0]?.[2], { command: 'uptime' });
  assert.equal(mockWaitForRunner.mock.calls[0]?.[4], 1_000);
  assert.equal(mockSendRunnerCommandOnce.mock.calls.length, 1);
});

test('runner session emits explicit diagnostics when ready sessions are probed', async () => {
  const session = makeRunnerSession({ state: 'ready' });
  mockWaitForRunner.mockResolvedValueOnce(runnerResponse({ uptimeMs: 42 }));
  mockSendRunnerCommandOnce.mockResolvedValueOnce(runnerResponse({ tapped: true }));

  const diagnostics = await captureDiagnostics(async () => {
    await executeRunnerCommandWithSession(
      IOS_SIMULATOR,
      session,
      { command: 'tap', x: 120, y: 240, appBundleId: 'com.example.demo' },
      '/tmp/runner.log',
      30_000,
    );
  });

  assert.match(diagnostics, /ios_runner_readiness_preflight/);
  assert.match(diagnostics, /"reason":"no_recent_healthy_mutation"/);
  assert.doesNotMatch(diagnostics, /ios_runner_readiness_preflight_skipped/);
});

test('runner session marks preflight failures for ready mutating commands', async () => {
  const session = makeRunnerSession({ state: 'ready' });
  mockWaitForRunner.mockRejectedValueOnce(new Error('fetch failed'));

  await assert.rejects(
    () =>
      executeRunnerCommandWithSession(
        IOS_SIMULATOR,
        session,
        { command: 'tap', x: 120, y: 240, appBundleId: 'com.example.demo' },
        '/tmp/runner.log',
        30_000,
      ),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.details?.runnerReadinessPreflightFailed, true);
      return true;
    },
  );
  assert.equal(mockSendRunnerCommandOnce.mock.calls.length, 0);
});

test('runner session preserves runner response failures after successful readiness preflight', async () => {
  const session = makeRunnerSession({ state: 'ready' });
  mockWaitForRunner.mockResolvedValueOnce(runnerResponse({ uptimeMs: 42 }));
  mockSendRunnerCommandOnce.mockResolvedValueOnce(
    runnerError({
      code: 'COMMAND_FAILED',
      message: 'Runner failed after receiving command',
    }),
  );

  await assert.rejects(
    () =>
      executeRunnerCommandWithSession(
        IOS_SIMULATOR,
        session,
        { command: 'tap', x: 120, y: 240, appBundleId: 'com.example.demo' },
        '/tmp/runner.log',
        30_000,
      ),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.message, 'Runner failed after receiving command');
      return true;
    },
  );
});

test('runner session probes readiness for ready selector taps', async () => {
  const session = makeRunnerSession({ state: 'ready' });
  mockWaitForRunner.mockResolvedValueOnce(runnerResponse({ uptimeMs: 42 }));
  mockSendRunnerCommandOnce.mockResolvedValueOnce(runnerResponse({ tapped: true }));

  const result = await executeRunnerCommandWithSession(
    IOS_SIMULATOR,
    session,
    {
      command: 'tap',
      selectorKey: 'label',
      selectorValue: 'Navigate to article',
      appBundleId: 'com.example.demo',
    },
    '/tmp/runner.log',
    30_000,
  );

  assert.deepEqual(result, { tapped: true });
  assert.equal(mockWaitForRunner.mock.calls.length, 1);
  assertRunnerCommand(mockWaitForRunner.mock.calls[0]?.[2], { command: 'uptime' });
  assert.equal(mockWaitForRunner.mock.calls[0]?.[4], 1_000);
  assert.equal(mockSendRunnerCommandOnce.mock.calls.length, 1);
});

test('runner session probes readiness for ready sequence commands', async () => {
  const session = makeRunnerSession({ state: 'ready' });
  mockWaitForRunner.mockResolvedValueOnce(runnerResponse({ uptimeMs: 42 }));
  mockSendRunnerCommandOnce.mockResolvedValueOnce(runnerResponse({ tapped: true }));

  const result = await executeRunnerCommandWithSession(
    IOS_SIMULATOR,
    session,
    {
      command: 'sequence',
      steps: [
        { kind: 'tap', x: 120, y: 240, pauseMs: 80 },
        { kind: 'tap', x: 120, y: 240 },
      ],
      appBundleId: 'com.example.demo',
    },
    '/tmp/runner.log',
    30_000,
  );

  assert.deepEqual(result, { tapped: true });
  assert.equal(mockWaitForRunner.mock.calls.length, 1);
  assertRunnerCommand(mockWaitForRunner.mock.calls[0]?.[2], { command: 'uptime' });
  assert.equal(mockWaitForRunner.mock.calls[0]?.[4], 1_000);
  assert.equal(mockSendRunnerCommandOnce.mock.calls.length, 1);
});

test('runner session keeps readiness preflight for ready tap commands without prior command state', async () => {
  const session = makeRunnerSession({ state: 'ready' });
  mockWaitForRunner.mockResolvedValueOnce(runnerResponse({ uptimeMs: 42 }));
  mockSendRunnerCommandOnce.mockResolvedValueOnce(runnerResponse({ tapped: true }));

  const result = await executeRunnerCommandWithSession(
    IOS_SIMULATOR,
    session,
    { command: 'tap', x: 120, y: 240, appBundleId: 'com.example.demo' },
    '/tmp/runner.log',
    30_000,
  );

  assert.deepEqual(result, { tapped: true });
  assert.equal(mockWaitForRunner.mock.calls.length, 1);
  assertRunnerCommand(mockWaitForRunner.mock.calls[0]?.[2], { command: 'uptime' });
  assert.equal(mockSendRunnerCommandOnce.mock.calls.length, 1);
});

test('runner session keeps readiness preflight for non-tap mutating commands when marked ready', async () => {
  const session = makeRunnerSession({ state: 'ready' });
  mockWaitForRunner.mockResolvedValueOnce(runnerResponse({ uptimeMs: 42 }));
  mockSendRunnerCommandOnce.mockResolvedValueOnce(runnerResponse({ pressed: true }));

  const result = await executeRunnerCommandWithSession(
    IOS_SIMULATOR,
    session,
    { command: 'longPress', x: 120, y: 240, appBundleId: 'com.example.demo' },
    '/tmp/runner.log',
    30_000,
  );

  assert.deepEqual(result, { pressed: true });
  assert.equal(mockWaitForRunner.mock.calls.length, 1);
  assertRunnerCommand(mockWaitForRunner.mock.calls[0]?.[2], { command: 'uptime' });
  assert.equal(mockSendRunnerCommandOnce.mock.calls.length, 1);
});

test('runner session preserves structured runner failures', async () => {
  const session = makeRunnerSession({ state: 'ready' });
  mockWaitForRunner.mockResolvedValueOnce(
    runnerError({
      code: 'COMMAND_FAILED',
      message: 'Runner crashed while reading snapshot',
    }),
  );

  await assert.rejects(
    () =>
      executeRunnerCommandWithSession(
        IOS_SIMULATOR,
        session,
        { command: 'snapshot', appBundleId: 'com.example.demo' },
        '/tmp/runner.log',
        30_000,
      ),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, 'COMMAND_FAILED');
      assert.equal(error.message, 'Runner crashed while reading snapshot');
      assert.equal(error.details?.logPath, '/tmp/runner.log');
      return true;
    },
  );
});

/**
 * The two startup probes answer different questions about different machines, and the order they run
 * in is a claim (#2683). Both answers can be wrong at once; the phone's is the one the caller can fix
 * without admin rights on the Mac, so the device is asked first and gets to speak. Probing the host
 * first would publish only the Mac's reason and hide the device's for as long as both held.
 */
test('a device and a Mac that are both wrong publish the device reason', async () => {
  const device = { ...IOS_DEVICE, id: 'runner-session-probe-order-device' };
  mockRunAppleToolCommand.mockImplementation(async (cmd: string, args: string[]) => {
    if (cmd === 'DevToolsSecurity' && args[0] === '-status') {
      return { exitCode: 0, stdout: 'Developer mode is currently disabled.\n', stderr: '' };
    }
    return { exitCode: 0, stdout: '', stderr: '' };
  });

  await assert.rejects(
    () =>
      withAppleToolProvider(
        createLocalAppleToolProvider({
          runCommand: async (_cmd: string, args: string[]) => {
            const outputPath = jsonOutputPathOf(args);
            if (outputPath) {
              fs.writeFileSync(outputPath, DEVELOPER_MODE_OFF_DETAILS_PAYLOAD);
            }
            return { exitCode: 0, stdout: '', stderr: '' };
          },
        }),
        () => ensureRunnerSession(device, {}),
      ),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.details?.reason, 'device_developer_mode_disabled');
      return true;
    },
  );
});

/** A device reporting its own toggle off while awake and connected: the state that makes it a fact. */
const DEVELOPER_MODE_OFF_DETAILS_PAYLOAD = JSON.stringify({
  info: { outcome: 'success' },
  result: {
    deviceProperties: {
      developerModeStatus: 'disabled',
      ddiServicesAvailable: false,
      bootState: 'booted',
    },
    connectionProperties: { tunnelState: 'connected' },
  },
});

/** Where `devicectl ... --json-output <path>` is told to put its payload. */
function jsonOutputPathOf(args: string[]): string | undefined {
  const index = args.indexOf('--json-output');
  return index >= 0 ? args[index + 1] : undefined;
}

/**
 * The startup catch — not the build catch — is where the device's own answer attaches (#2690 review):
 * a cold build, a warm derived cache that fails at install, and an external xctestrun that never
 * launches are different steps, and a caller told "developer disk image" should not have to know which
 * one this run happened to take. What each step throws below is the shape that step publishes; what is
 * under test is what the session adds on the way out.
 */
test('a build that named no cause on a device with its image down gets the device answer', async () => {
  const device = { ...IOS_DEVICE, id: 'runner-session-image-down-build' };
  mockEnsureXctestrunArtifact.mockRejectedValue(
    new AppError('COMMAND_FAILED', 'xcodebuild build-for-testing failed', {
      reason: 'build_failed_unclassified',
      startupRuleMatched: false,
      details: { stdout: "error: cannot find 'AgentDeviceRunnerCommand' in scope\n" },
    }),
  );

  const error = await expectStartupFailure(device, deviceDetailsPayload('enabled', false));

  assert.equal(error.details?.reason, 'device_developer_disk_image_unavailable');
  assert.equal(error.details?.developerDiskImage, 'unavailable');
  assert.ok(String(error.details?.hint).includes(IOS_DEVICE_DEVELOPER_DISK_IMAGE_HINT));
});

test('a warm cache that fails at launch still carries what the device said', async () => {
  // The case the build-catch-only version missed: nothing had to compile, so the device's answer was
  // never attached anywhere, and an install that cannot start the runner said only "build failed".
  const device = { ...IOS_DEVICE, id: 'runner-session-image-down-launch' };
  mockEnsureXctestrunArtifact.mockResolvedValue({
    xctestrunPath: '/tmp/base-runner.xctestrun',
    derived: '/tmp/derived',
    cache: 'exact',
    artifact: 'valid',
    buildMs: 0,
    xctestrunPathSource: 'manifest',
  });
  mockRunCmdBackground.mockImplementation(() => {
    throw new AppError('COMMAND_FAILED', 'xcodebuild test-without-building exited unexpectedly');
  });

  const error = await expectStartupFailure(device, deviceDetailsPayload('enabled', false));

  assert.equal(error.details?.reason, 'device_developer_disk_image_unavailable');
  assert.equal(error.details?.developerDiskImage, 'unavailable');
});

test('a device whose image is available claims nothing for a failure it did not cause', async () => {
  const device = { ...IOS_DEVICE, id: 'runner-session-image-available' };
  mockEnsureXctestrunArtifact.mockRejectedValue(
    new AppError('COMMAND_FAILED', 'xcodebuild build-for-testing failed', {
      reason: 'build_failed_unclassified',
      startupRuleMatched: false,
      details: { stdout: "error: cannot find 'AgentDeviceRunnerCommand' in scope\n" },
    }),
  );

  const error = await expectStartupFailure(device, deviceDetailsPayload('enabled', true));

  assert.equal(error.details?.reason, 'build_failed_unclassified');
  assert.equal(error.details?.developerDiskImage, 'available');
});

/** `devicectl device info details` for a phone that is awake, connected, and reporting both states. */
function deviceDetailsPayload(
  developerModeStatus: 'enabled' | 'disabled',
  ddiServicesAvailable: boolean,
): string {
  return JSON.stringify({
    info: { outcome: 'success' },
    result: {
      deviceProperties: {
        developerModeStatus,
        ddiServicesAvailable,
        bootState: 'booted',
      },
      connectionProperties: { tunnelState: 'connected' },
    },
  });
}

/** Starts a session against a device whose `devicectl` answers with `payload`, and returns the failure. */
async function expectStartupFailure(device: typeof IOS_DEVICE, payload: string): Promise<AppError> {
  let caught: unknown;
  await assert.rejects(
    () =>
      withAppleToolProvider(
        createLocalAppleToolProvider({
          runCommand: async (_cmd: string, args: string[]) => {
            const outputPath = jsonOutputPathOf(args);
            if (outputPath) {
              fs.writeFileSync(outputPath, payload);
            }
            return { exitCode: 0, stdout: '', stderr: '' };
          },
        }),
        () => ensureRunnerSession(device, {}),
      ),
    (error: unknown) => {
      caught = error;
      return true;
    },
  );
  assert.ok(caught instanceof AppError, 'startup must fail with an AppError');
  return caught;
}
