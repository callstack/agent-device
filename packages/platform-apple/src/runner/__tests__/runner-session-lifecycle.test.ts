import assert from 'node:assert/strict';
import { beforeEach, test, vi } from 'vitest';
import { IOS_SIMULATOR } from './device-fixtures.ts';
import { appleRunnerTestHost } from '../test-host.ts';
import {
  makeClassifyOwnerLivenessViaMocks,
  assertRunnerCommand,
  makeBackgroundRunner,
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
  runnerStateTransitions,
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
  runnerStateTransitions: [] as string[],
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

vi.mock('../runner-disposal.ts', async () => {
  const actual =
    await vi.importActual<typeof import('../runner-disposal.ts')>('../runner-disposal.ts');
  return {
    ...actual,
    disposeRunnerSession: vi.fn(actual.disposeRunnerSession),
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

vi.mock('../runner-session-types.ts', async () => {
  const actual = await vi.importActual<typeof import('../runner-session-types.ts')>(
    '../runner-session-types.ts',
  );
  return {
    ...actual,
    advanceRunnerSessionState(
      session: Parameters<typeof actual.advanceRunnerSessionState>[0],
      next: Parameters<typeof actual.advanceRunnerSessionState>[1],
    ): void {
      runnerStateTransitions.push(next);
      actual.advanceRunnerSessionState(session, next);
    },
  };
});

import { disposeRunnerSession } from '../runner-disposal.ts';
import { hasLiveIosRunnerSession } from '../runner-client.ts';
import {
  abortAllIosRunnerSessions,
  detachIosSimulatorRunnerSessionsForShutdown,
  ensureRunnerSession,
  executeRunnerCommandWithSession,
  invalidateRunnerSession,
  readRunnerSessionLiveness,
  scheduleIosRunnerIdleStop,
  stopIosRunnerSession,
} from '../runner-session.ts';

let leaseOwnerStateDirOverride: string | undefined;
function setRunnerLeaseOwnerStateDir(stateDir: string | undefined): void {
  leaseOwnerStateDirOverride = stateDir;
}

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
  runnerStateTransitions.length = 0;
  const actualDisposal =
    await vi.importActual<typeof import('../runner-disposal.ts')>('../runner-disposal.ts');
  vi.mocked(disposeRunnerSession).mockImplementation(async (session, options) =>
    actualDisposal.disposeRunnerSession(session, options),
  );
  setRunnerLeaseOwnerStateDir(undefined);
  process.env.AGENT_DEVICE_IOS_RUNNER_LEASE_DIR = mkdtempForTestSync(
    'agent-device-runner-lifecycle-test-',
  );
  delete process.env.AGENT_DEVICE_IOS_RUNNER_IDLE_STOP_MS;
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

test('a startup publishes starting and its first answer publishes ready', async () => {
  const device = { ...IOS_SIMULATOR, id: 'runner-lifecycle-first-answer' };
  const session = await ensureRunnerSession(device, {});

  assert.equal(session.state, 'starting');
  assert.deepEqual(readRunnerSessionLiveness(device.id), {
    sessionId: session.sessionId,
    liveness: 'starting',
  });
  assert.equal(hasLiveIosRunnerSession(device), false);

  mockWaitForRunner.mockResolvedValueOnce(runnerResponse({ nodes: [], truncated: false }));
  await executeRunnerCommandWithSession(
    device,
    session,
    { command: 'snapshot', appBundleId: 'com.example.demo' },
    '/tmp/runner.log',
    30_000,
  );

  assert.equal(session.state, 'ready');
  assert.deepEqual(readRunnerSessionLiveness(device.id), {
    sessionId: session.sessionId,
    liveness: 'ready',
  });
  assert.equal(hasLiveIosRunnerSession(device), true);
});

test('an idle stop moves a ready session through disposal to stopped', async () => {
  const device = { ...IOS_SIMULATOR, id: 'runner-lifecycle-idle-stop' };
  process.env.AGENT_DEVICE_IOS_RUNNER_IDLE_STOP_MS = '1';
  const session = await ensureRunnerSession(device, {});
  mockWaitForRunner.mockResolvedValueOnce(runnerResponse({ nodes: [], truncated: false }));
  await executeRunnerCommandWithSession(
    device,
    session,
    { command: 'snapshot', appBundleId: 'com.example.demo' },
    '/tmp/runner.log',
    30_000,
  );

  scheduleIosRunnerIdleStop(device.id);
  await vi.waitFor(() => assert.equal(session.state, 'stopped'));

  assert.equal(
    readRunnerSessionLiveness(device.id),
    null,
    'the idle stop removes the session from the device registry',
  );
  assert.equal(hasLiveIosRunnerSession(device), false);
});

test('stopping the same registered runner twice tears it down once', async () => {
  const device = { ...IOS_SIMULATOR, id: 'runner-lifecycle-stop-twice' };
  const session = await ensureRunnerSession(device, {});

  await stopIosRunnerSession(device.id);
  assert.equal(vi.mocked(disposeRunnerSession).mock.calls.length, 1);
  assert.equal(session.state, 'stopped');
  assert.equal(readRunnerSessionLiveness(device.id), null);

  await stopIosRunnerSession(device.id);
  assert.equal(vi.mocked(disposeRunnerSession).mock.calls.length, 1);
});

test('stop and invalidate do not start a second disposal already in progress', async () => {
  const device = { ...IOS_SIMULATOR, id: 'runner-lifecycle-concurrent-stop' };
  const session = await ensureRunnerSession(device, {});
  let resolveShutdown!: (response: Response) => void;
  mockWaitForRunner.mockImplementationOnce(
    () =>
      new Promise<Response>((resolve) => {
        resolveShutdown = resolve;
      }),
  );

  const disposal = disposeRunnerSession(session);
  await vi.waitFor(() => assert.equal(session.state, 'draining'));
  assert.equal(hasLiveIosRunnerSession(device), false);

  await stopIosRunnerSession(device.id);
  await invalidateRunnerSession(session, 'late command failure');

  assert.equal(vi.mocked(disposeRunnerSession).mock.calls.length, 1);
  assert.equal(mockWaitForRunner.mock.calls.length, 1);
  resolveShutdown(runnerResponse({ uptimeMs: 1 }));
  await disposal;

  assert.equal(session.state, 'stopped');
});

test('an answer parsed by a draining session cannot revive it', async () => {
  const device = { ...IOS_SIMULATOR, id: 'runner-lifecycle-late-answer' };
  const session = await ensureRunnerSession(device, {});
  let resolveShutdown!: (response: Response) => void;
  mockWaitForRunner.mockImplementationOnce(
    () =>
      new Promise<Response>((resolve) => {
        resolveShutdown = resolve;
      }),
  );

  const disposal = disposeRunnerSession(session);
  await vi.waitFor(() => assert.equal(session.state, 'draining'));

  mockWaitForRunner.mockResolvedValueOnce(runnerResponse({ nodes: [], truncated: false }));
  await executeRunnerCommandWithSession(
    device,
    session,
    { command: 'snapshot', appBundleId: 'com.example.demo' },
    '/tmp/runner.log',
    30_000,
  );

  assert.equal(session.state, 'draining');
  assert.equal(readRunnerSessionLiveness(device.id)?.liveness, 'draining');
  assert.equal(hasLiveIosRunnerSession(device), false);
  assertRunnerCommand(mockWaitForRunner.mock.calls[1]?.[2], {
    command: 'snapshot',
    appBundleId: 'com.example.demo',
  });

  resolveShutdown(runnerResponse({ uptimeMs: 1 }));
  await disposal;
  assert.equal(session.state, 'stopped');
});

test('an abort drains a registered runner before reporting it stopped', async () => {
  const device = { ...IOS_SIMULATOR, id: 'runner-lifecycle-abort' };
  const session = await ensureRunnerSession(device, {});
  runnerStateTransitions.length = 0;

  await abortAllIosRunnerSessions();

  assert.deepEqual(runnerStateTransitions, ['draining', 'stopped']);
  assert.equal(session.state, 'stopped');
  assert.equal(readRunnerSessionLiveness(device.id), null);
});

test('shutdown detach moves a handed-off session to stopped without killing its runner', async () => {
  const device = { ...IOS_SIMULATOR, id: 'runner-lifecycle-detach' };
  mockAcquireXcodebuildSimulatorSetRedirect.mockResolvedValue(null);
  const session = await ensureRunnerSession(device, {});
  const runnerPid = session.child.pid;
  assert.ok(runnerPid);
  runnerStateTransitions.length = 0;

  assert.equal(await detachIosSimulatorRunnerSessionsForShutdown(), 1);

  assert.equal(session.state, 'stopped');
  assert.deepEqual(runnerStateTransitions, ['stopped']);
  assert.equal(readRunnerSessionLiveness(device.id), null);
  assert.equal(mockIsProcessAlive(runnerPid), true);
});

test('a registered runner whose process died is recycled instead of reused', async () => {
  const device = { ...IOS_SIMULATOR, id: 'runner-lifecycle-dead-process' };
  const first = await ensureRunnerSession(device, {});
  const firstPid = first.child.pid;
  assert.ok(firstPid);
  runnerStateTransitions.length = 0;

  mockIsProcessAlive.mockImplementation((pid: number) => pid !== firstPid);
  assert.deepEqual(readRunnerSessionLiveness(device.id), {
    sessionId: first.sessionId,
    liveness: 'gone',
  });

  mockGetFreePort.mockResolvedValueOnce(8124);
  mockRunCmdBackground.mockReturnValueOnce(makeBackgroundRunner(firstPid + 1));
  const second = await ensureRunnerSession(device, {});

  assert.notEqual(second.sessionId, first.sessionId);
  assert.equal(second.child.pid, firstPid + 1);
  assert.equal(first.state, 'stopped');
  assert.deepEqual(runnerStateTransitions, ['draining', 'stopped']);
  assert.deepEqual(readRunnerSessionLiveness(device.id), {
    sessionId: second.sessionId,
    liveness: 'starting',
  });
});

test('a draining session is never reused while its next command starts a fresh runner', async () => {
  const device = { ...IOS_SIMULATOR, id: 'runner-lifecycle-draining-reuse' };
  const first = await ensureRunnerSession(device, {});
  let resolveShutdown!: (response: Response) => void;
  mockWaitForRunner.mockImplementationOnce(
    () =>
      new Promise<Response>((resolve) => {
        resolveShutdown = resolve;
      }),
  );

  const disposal = disposeRunnerSession(first);
  await vi.waitFor(() => assert.equal(first.state, 'draining'));

  mockGetFreePort.mockResolvedValueOnce(8124);
  mockRunCmdBackground.mockReturnValueOnce(makeBackgroundRunner(4243));
  const second = await ensureRunnerSession(device, {});

  assert.notEqual(second.sessionId, first.sessionId);
  assert.equal(first.state, 'draining');
  assert.deepEqual(readRunnerSessionLiveness(device.id), {
    sessionId: second.sessionId,
    liveness: 'starting',
  });

  resolveShutdown(runnerResponse({ uptimeMs: 1 }));
  await disposal;
  assert.equal(first.state, 'stopped');
  assert.equal(second.state, 'starting');
});
