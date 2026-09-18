import assert from 'node:assert/strict';
import { beforeEach, test, vi } from 'vitest';
import { IOS_SIMULATOR } from './device-fixtures.ts';
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
  redirectHandle,
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
} = vi.hoisted(() => ({
  mockAcquireXcodebuildSimulatorSetRedirect: vi.fn(),
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
    acquireXcodebuildSimulatorSetRedirect: mockAcquireXcodebuildSimulatorSetRedirect,
    ensureXctestrunArtifact: mockEnsureXctestrunArtifact,
    prepareXctestrunWithEnv: mockPrepareXctestrunWithEnv,
    resolveExpectedRunnerCacheMetadata: mockResolveExpectedRunnerCacheMetadata,
    resolveRunnerDerivedPath: mockResolveRunnerDerivedPath,
  };
});

import { abortAllIosRunnerSessions, executeRunnerCommandWithSession } from '../runner-session.ts';

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
  mockAcquireXcodebuildSimulatorSetRedirect.mockResolvedValue(redirectHandle);
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
