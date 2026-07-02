import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, test, vi } from 'vitest';
import { IOS_DEVICE, IOS_SIMULATOR } from '../../../../__tests__/test-utils/index.ts';
import {
  type RequestProgressEvent,
  withRequestProgressSink,
} from '../../../../daemon/request-progress.ts';
import { AppError } from '../../../../kernel/errors.ts';
import {
  flushDiagnosticsToSessionFile,
  withDiagnosticsScope,
} from '../../../../utils/diagnostics.ts';
import type { RunnerSession } from '../runner/runner-session-types.ts';

const {
  mockAcquireXcodebuildSimulatorSetRedirect,
  mockCleanupTempFile,
  mockEnsureXctestrunArtifact,
  mockGetFreePort,
  mockIsProcessAlive,
  mockIsProcessGroupAlive,
  mockPrepareXctestrunWithEnv,
  mockResolveExpectedRunnerCacheMetadata,
  mockResolveRunnerDerivedPath,
  mockRunAppleToolCommand,
  mockRunCmdBackground,
  mockRunXcrun,
  mockSendRunnerCommandOnce,
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
  mockResolveExpectedRunnerCacheMetadata: vi.fn(),
  mockResolveRunnerDerivedPath: vi.fn(),
  mockRunAppleToolCommand: vi.fn(),
  mockRunCmdBackground: vi.fn(),
  mockRunXcrun: vi.fn(),
  mockSendRunnerCommandOnce: vi.fn(),
  mockWaitForRunner: vi.fn(),
  mockRedirectRelease: vi.fn(),
}));

vi.mock('../../../../utils/exec.ts', async () => {
  const actual = await vi.importActual<typeof import('../../../../utils/exec.ts')>(
    '../../../../utils/exec.ts',
  );
  return {
    ...actual,
    runCmdBackground: mockRunCmdBackground,
  };
});

vi.mock('../../../../utils/process-identity.ts', async () => {
  const actual = await vi.importActual<typeof import('../../../../utils/process-identity.ts')>(
    '../../../../utils/process-identity.ts',
  );
  return {
    ...actual,
    isProcessAlive: mockIsProcessAlive,
    isProcessGroupAlive: mockIsProcessGroupAlive,
  };
});

vi.mock('../tool-provider.ts', async () => {
  const actual = await vi.importActual<typeof import('../tool-provider.ts')>('../tool-provider.ts');
  return {
    ...actual,
    runAppleToolCommand: mockRunAppleToolCommand,
    runXcrun: mockRunXcrun,
  };
});

vi.mock('../runner/runner-transport.ts', async () => {
  const actual = await vi.importActual<typeof import('../runner/runner-transport.ts')>(
    '../runner/runner-transport.ts',
  );
  return {
    ...actual,
    cleanupTempFile: mockCleanupTempFile,
    getFreePort: mockGetFreePort,
    sendRunnerCommandOnce: mockSendRunnerCommandOnce,
    waitForRunner: mockWaitForRunner,
  };
});

vi.mock('../runner/runner-xctestrun.ts', async () => {
  const actual = await vi.importActual<typeof import('../runner/runner-xctestrun.ts')>(
    '../runner/runner-xctestrun.ts',
  );
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
  detachIosSimulatorRunnerSessionsForShutdown,
  ensureRunnerSession,
  executeRunnerCommandWithSession,
  getRunnerSessionSnapshot,
  invalidateRunnerSession,
  stopIosRunnerSession,
  validateRunnerDevice,
} from '../runner/runner-session.ts';
import {
  cleanupRunnerLeasesForOwner,
  RUNNER_OWNER_START_TIME,
  RUNNER_OWNER_TOKEN,
  setRunnerLeaseOwnerStateDir,
  writeRunnerLease,
  type RunnerLease,
} from '../runner/runner-lease.ts';

beforeEach(async () => {
  await abortAllIosRunnerSessions();
  vi.resetAllMocks();
  setRunnerLeaseOwnerStateDir(undefined);
  process.env.AGENT_DEVICE_IOS_RUNNER_LEASE_DIR = fs.mkdtempSync(
    path.join(os.tmpdir(), 'agent-device-runner-lease-test-'),
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
  mockWaitForRunner.mockResolvedValue(runnerResponse({ uptimeMs: 1 }));
});

test('runner session executes read-only commands without uptime preflight', async () => {
  const session = makeRunnerSession({ ready: false });
  mockWaitForRunner.mockResolvedValueOnce(runnerResponse({ nodes: [], truncated: false }));

  const result = await executeRunnerCommandWithSession(
    IOS_SIMULATOR,
    session,
    { command: 'snapshot', appBundleId: 'com.example.demo' },
    '/tmp/runner.log',
    30_000,
  );

  assert.deepEqual(result, { nodes: [], truncated: false });
  assert.equal(session.ready, true);
  assert.equal(mockWaitForRunner.mock.calls.length, 1);
  assertRunnerCommand(mockWaitForRunner.mock.calls[0]?.[2], {
    command: 'snapshot',
    appBundleId: 'com.example.demo',
  });
  assert.equal(mockSendRunnerCommandOnce.mock.calls.length, 0);
});

test('runner session probes readiness before ready read-only commands', async () => {
  const session = makeRunnerSession({ ready: true });
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
  const session = makeRunnerSession({ ready: true });
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
  const session = makeRunnerSession({ ready: true });
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
  const session = makeRunnerSession({ ready: false });
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
  assert.equal(session.ready, true);
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
  const session = makeRunnerSession({ ready: false });
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
  const session = makeRunnerSession({ ready: true });
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
  const session = makeRunnerSession({ ready: true });
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
  const session = makeRunnerSession({ ready: true });
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
  const session = makeRunnerSession({ ready: true });
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
  const session = makeRunnerSession({ ready: true });
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
  const session = makeRunnerSession({ ready: true });
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
  const session = makeRunnerSession({ ready: true });
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
  const session = makeRunnerSession({ ready: true });
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
  const session = makeRunnerSession({ ready: true });
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

test('runner session invalidates after runner-fatal ok payloads', async () => {
  const device = { ...IOS_SIMULATOR, id: 'runner-session-fatal-payload-sim' };
  const session = await ensureRunnerSession(device, {});
  mockWaitForRunner.mockClear();
  mockWaitForRunner.mockResolvedValueOnce(
    runnerResponse({
      message: 'iOS XCTest snapshot failed with kAXErrorIllegalArgument.',
      nodes: [],
      truncated: true,
      runnerFatal: true,
      runnerFatalReason: 'ax_snapshot_unavailable',
    }),
  );

  const result = await executeRunnerCommandWithSession(
    device,
    session,
    { command: 'snapshot', appBundleId: 'com.example.demo' },
    '/tmp/runner.log',
    30_000,
  );

  assert.equal(result.runnerFatal, true);
  assert.equal(result.runnerFatalReason, 'ax_snapshot_unavailable');
  assert.equal(getRunnerSessionSnapshot(device.id), null);
  assert.equal(
    mockRunAppleToolCommand.mock.calls.some((call) => call[0] === 'pkill'),
    true,
  );
});

test('runner session invalidates after XCTest recorded mutation failures', async () => {
  const device = { ...IOS_SIMULATOR, id: 'runner-session-xctest-failure-sim' };
  const session = await ensureRunnerSession(device, {});
  mockWaitForRunner.mockClear();
  mockWaitForRunner.mockResolvedValueOnce(runnerResponse({ uptimeMs: 42 }));
  mockSendRunnerCommandOnce.mockResolvedValueOnce(
    runnerError({
      code: 'XCTEST_RECORDED_FAILURE',
      message:
        'XCTest recorded a failure while executing tap; the action may not have been performed.',
    }),
  );

  await assert.rejects(
    () =>
      executeRunnerCommandWithSession(
        device,
        session,
        { command: 'tap', x: 120, y: 240, appBundleId: 'com.example.demo' },
        '/tmp/runner.log',
        30_000,
      ),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, 'XCTEST_RECORDED_FAILURE');
      assert.match(error.message, /may not have been performed/);
      return true;
    },
  );
  assert.equal(getRunnerSessionSnapshot(device.id), null);
  assert.equal(
    mockRunAppleToolCommand.mock.calls.some((call) => call[0] === 'pkill'),
    true,
  );
});

test('runner session starts xcodebuild through provider seams and reuses an alive session', async () => {
  const device = { ...IOS_SIMULATOR, id: 'runner-session-start-sim' };

  const session = await ensureRunnerSession(device, {
    verbose: true,
    logPath: '/tmp/runner.log',
    traceLogPath: '/tmp/runner.trace',
  });
  const reused = await ensureRunnerSession(device, {});

  assert.equal(reused, session);
  assert.equal(session.port, 8123);
  assert.equal(session.xctestrunPath, '/tmp/session-runner.xctestrun');
  assert.equal(mockRunCmdBackground.mock.calls.length, 1);
  assert.equal(mockRunCmdBackground.mock.calls[0]?.[0], 'xcodebuild');
  const xcodebuildArgs = mockRunCmdBackground.mock.calls[0]?.[1];
  assert.ok(Array.isArray(xcodebuildArgs));
  assert.equal(xcodebuildArgs[xcodebuildArgs.indexOf('-derivedDataPath') + 1], '/tmp/derived');
  assert.deepEqual(mockPrepareXctestrunWithEnv.mock.calls[0]?.[1], {
    AGENT_DEVICE_RUNNER_PORT: '8123',
  });
  assert.match(
    String(mockPrepareXctestrunWithEnv.mock.calls[0]?.[2] ?? ''),
    /^session-runner-session-start-sim-owner-\d+-[a-f0-9]{8}-8123$/,
  );
  assert.equal(
    mockRunXcrun.mock.calls.some((call) => call[0]?.includes('bootstatus')),
    false,
  );
  assert.equal(
    mockRunXcrun.mock.calls.some((call) => call[0]?.includes('uninstall')),
    false,
  );
  assert.deepEqual(getRunnerSessionSnapshot(device.id), {
    sessionId: session.sessionId,
    alive: true,
  });
});

test('runner session emits XCTest startup progress only after a runner rebuild', async () => {
  const rebuiltDevice = { ...IOS_SIMULATOR, id: 'runner-session-rebuilt-progress-sim' };
  const rebuiltEvents: RequestProgressEvent[] = [];

  await withRequestProgressSink(
    (event) => rebuiltEvents.push(event),
    async () => {
      await ensureRunnerSession(rebuiltDevice, {});
    },
  );

  assert.deepEqual(rebuiltEvents, [
    {
      type: 'command',
      status: 'progress',
      message: 'Starting XCTest runner...',
    },
  ]);

  await abortAllIosRunnerSessions();
  vi.clearAllMocks();
  mockEnsureXctestrunArtifact.mockResolvedValue({
    xctestrunPath: '/tmp/cached-runner.xctestrun',
    derived: '/tmp/derived',
    cache: 'hit',
    artifact: 'valid',
    buildMs: 0,
    xctestrunPathSource: 'manifest',
  });
  mockGetFreePort.mockResolvedValue(8123);
  mockPrepareXctestrunWithEnv.mockResolvedValue({
    xctestrunPath: '/tmp/session-runner.xctestrun',
    jsonPath: '/tmp/session-runner.json',
  });
  mockAcquireXcodebuildSimulatorSetRedirect.mockResolvedValue({ release: mockRedirectRelease });
  mockRunCmdBackground.mockReturnValue(makeBackgroundRunner(4242));
  mockWaitForRunner.mockResolvedValue(runnerResponse({ uptimeMs: 1 }));

  const cachedDevice = { ...IOS_SIMULATOR, id: 'runner-session-cached-progress-sim' };
  const cachedEvents: RequestProgressEvent[] = [];
  await withRequestProgressSink(
    (event) => cachedEvents.push(event),
    async () => {
      await ensureRunnerSession(cachedDevice, {});
    },
  );

  assert.deepEqual(cachedEvents, []);
});

test('runner session startup diagnostics include logical lease context', async () => {
  const device = { ...IOS_SIMULATOR, id: 'runner-session-lease-context-sim' };

  const diagnostics = await captureDiagnostics(async () => {
    await ensureRunnerSession(device, {
      runnerLeaseContext: {
        tenantId: 'tenant-123',
        runId: 'run-456',
        leaseId: 'lease-789',
        leaseProvider: 'ios-simulator',
      },
    });
  });

  assert.match(diagnostics, /ios_runner_session_startup/);
  assert.match(diagnostics, /"logicalLeaseContext"/);
  assert.match(diagnostics, /"tenantId":"tenant-123"/);
  assert.match(diagnostics, /"runId":"run-456"/);
  assert.match(diagnostics, /"leaseId":"lease-789"/);
  assert.match(diagnostics, /"leaseProvider":"ios-simulator"/);
  assert.match(diagnostics, /"deviceKey":"runner-session-lease-context-sim"/);
});

test('runner session fails early for physical iOS devices when Apple developer mode is disabled', async () => {
  const device = { ...IOS_DEVICE, id: 'runner-session-devtools-disabled-device' };
  mockDevToolsSecurityDisabled();

  await assert.rejects(
    () => ensureRunnerSession(device, {}),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, 'COMMAND_FAILED');
      assert.match(error.message, /Developer mode is disabled/);
      assert.match(String(error.details?.hint ?? ''), /DevToolsSecurity -enable/);
      return true;
    },
  );

  assert.equal(mockEnsureXctestrunArtifact.mock.calls.length, 0);
  assert.equal(mockRunCmdBackground.mock.calls.length, 0);
});

test('runner session does not require Apple developer mode for iOS simulators', async () => {
  const device = { ...IOS_SIMULATOR, id: 'runner-session-devtools-disabled-sim' };
  mockDevToolsSecurityDisabled();

  const session = await ensureRunnerSession(device, {});

  assert.equal(session.deviceId, device.id);
  assert.equal(mockEnsureXctestrunArtifact.mock.calls.length, 1);
  assert.equal(mockRunCmdBackground.mock.calls.length, 1);
  assert.equal(mockRunAppleToolCommand.mock.calls.some(isDevToolsSecurityStatusCall), false);
});

test('shutdown detach hands off default-set simulator runner sessions', async () => {
  const device = { ...IOS_SIMULATOR, id: 'runner-session-detach-default-sim' };
  // Default simulator set: no XCTestDevices redirect is held.
  mockAcquireXcodebuildSimulatorSetRedirect.mockResolvedValue(null);
  await ensureRunnerSession(device, {});

  const detached = await detachIosSimulatorRunnerSessionsForShutdown();

  assert.equal(detached, 1);
  assert.equal(getRunnerSessionSnapshot(device.id), null);
  const leaseRaw = fs.readFileSync(
    path.join(process.env.AGENT_DEVICE_IOS_RUNNER_LEASE_DIR ?? '', `${device.id}.json`),
    'utf8',
  );
  const lease = JSON.parse(leaseRaw) as { ownerToken: string };
  assert.match(lease.ownerToken, /^detached-owner-/);
});

test('shutdown detach keeps scoped simulator-set runner sessions for the kill path', async () => {
  const device = {
    ...IOS_SIMULATOR,
    id: 'runner-session-detach-scoped-sim',
    simulatorSetPath: '/tmp/custom-device-set',
  };
  await ensureRunnerSession(device, {});
  assert.equal(mockAcquireXcodebuildSimulatorSetRedirect.mock.calls.length, 1);

  const detached = await detachIosSimulatorRunnerSessionsForShutdown();

  // The redirect-holding session must stay for disposal, which restores the
  // XCTestDevices symlink; detach never releases the redirect itself.
  assert.equal(detached, 0);
  assert.ok(getRunnerSessionSnapshot(device.id));
  assert.equal(mockRedirectRelease.mock.calls.length, 0);
});

test('runner session startup kills legacy ownerless xcodebuild before launching a new runner', async () => {
  const device = { ...IOS_SIMULATOR, id: 'runner-session-startup-stale-sim' };

  await ensureRunnerSession(device, {});

  const pkillCalls = mockRunAppleToolCommand.mock.calls.filter(isXcodebuildPkillCall);
  assert.equal(pkillCalls.length, 2);
  assert.deepEqual(pkillCalls[0]?.[1]?.slice(0, 2), ['-TERM', '-f']);
  assert.deepEqual(pkillCalls[1]?.[1]?.slice(0, 2), ['-KILL', '-f']);
  assert.match(
    String(pkillCalls[0]?.[1]?.[2] ?? ''),
    /xcodebuild\.\*test-without-building\.\*AgentDeviceRunner\\\.env\\\.session-runner-session-startup-stale-sim-\[0-9\]/,
  );
  const staleCleanupCallOrder = mockRunAppleToolCommand.mock.invocationCallOrder[0];
  const runnerLaunchCallOrder = mockRunCmdBackground.mock.invocationCallOrder[0];
  assert.ok(staleCleanupCallOrder !== undefined);
  assert.ok(runnerLaunchCallOrder !== undefined);
  assert.ok(staleCleanupCallOrder < runnerLaunchCallOrder);
});

test('runner session startup rejects live foreign runner lease', async () => {
  const device = { ...IOS_SIMULATOR, id: 'runner-session-busy-lease-sim' };
  const previousStateDir = process.env.AGENT_DEVICE_STATE_DIR;
  process.env.AGENT_DEVICE_STATE_DIR = '/tmp/agent-device-current';
  writeRunnerLease(
    makeRunnerLease({
      deviceId: device.id,
      ownerToken: 'owner-foreign-live',
      ownerPid: process.pid,
      ownerStartTime: RUNNER_OWNER_START_TIME,
      ownerStateDir: '/tmp/agent-device-owner',
    }),
  );

  try {
    let thrown: unknown;
    await assert.rejects(async () => {
      try {
        await ensureRunnerSession(device, {});
      } catch (error) {
        thrown = error;
        throw error;
      }
    }, /already owned by another agent-device daemon/);

    assert.equal(
      (thrown as { details?: Record<string, unknown> }).details?.ownerStateDir,
      '/tmp/agent-device-owner',
    );
    assert.match(
      String((thrown as { details?: Record<string, unknown> }).details?.hint),
      /Do not run prepare ios-runner/,
    );
    assert.match(
      String((thrown as { details?: Record<string, unknown> }).details?.hint),
      /^If it is stuck, stop the owning agent-device daemon for AGENT_DEVICE_STATE_DIR='\/tmp\/agent-device-owner' and retry/,
    );
    assert.doesNotMatch(
      String((thrown as { details?: Record<string, unknown> }).details?.hint),
      /pnpm|clean:daemon/,
    );
    assert.match(
      String((thrown as { details?: Record<string, unknown> }).details?.hint),
      /PID \d+ with AGENT_DEVICE_STATE_DIR=\/tmp\/agent-device-owner/,
    );
    assert.doesNotMatch(
      String((thrown as { details?: Record<string, unknown> }).details?.hint),
      /AGENT_DEVICE_STATE_DIR=\/tmp\/agent-device-owner\./,
    );
    assert.doesNotMatch(
      String((thrown as { details?: Record<string, unknown> }).details?.hint),
      /Current daemon state dir/,
    );
    assert.equal(mockRunCmdBackground.mock.calls.length, 0);
    assert.equal(
      mockRunAppleToolCommand.mock.calls.some((call) => call[0] === 'pkill'),
      false,
    );
  } finally {
    if (previousStateDir === undefined) delete process.env.AGENT_DEVICE_STATE_DIR;
    else process.env.AGENT_DEVICE_STATE_DIR = previousStateDir;
  }
});

test('runner session busy error includes logical lease context after admission', async () => {
  const device = { ...IOS_SIMULATOR, id: 'runner-session-logical-busy-lease-sim' };
  writeRunnerLease(
    makeRunnerLease({
      deviceId: device.id,
      ownerToken: 'owner-foreign-logical-live',
      ownerPid: process.pid,
      ownerStartTime: RUNNER_OWNER_START_TIME,
      ownerStateDir: '/tmp/agent-device-owner',
    }),
  );

  let thrown: unknown;
  await assert.rejects(async () => {
    try {
      await ensureRunnerSession(device, {
        runnerLeaseContext: {
          tenantId: 'tenant-123',
          runId: 'run-456',
          leaseId: 'lease-789',
          leaseProvider: 'ios-simulator',
        },
      });
    } catch (error) {
      thrown = error;
      throw error;
    }
  }, /busy after device lease admission/);

  assert.ok(thrown instanceof AppError);
  assert.deepEqual(thrown.details?.logicalLeaseContext, {
    tenantId: 'tenant-123',
    runId: 'run-456',
    leaseId: 'lease-789',
    leaseProvider: 'ios-simulator',
    deviceKey: device.id,
  });
  assert.match(String(thrown.details?.hint), /five-minute inactivity lease expires/);
  assert.match(
    String(thrown.details?.hint),
    /^If it is stuck, stop the owning agent-device daemon for AGENT_DEVICE_STATE_DIR='\/tmp\/agent-device-owner' and retry/,
  );
  assert.doesNotMatch(String(thrown.details?.hint), /pnpm|clean:daemon/);
  assert.match(
    String(thrown.details?.hint),
    /Runner owner: PID \d+ with AGENT_DEVICE_STATE_DIR=\/tmp\/agent-device-owner/,
  );
  assert.doesNotMatch(
    String(thrown.details?.hint),
    /AGENT_DEVICE_STATE_DIR=\/tmp\/agent-device-owner\./,
  );
  assert.equal(mockRunCmdBackground.mock.calls.length, 0);
});

test('runner session startup reclaims live foreign runner lease after proxy lease admission', async () => {
  const device = { ...IOS_SIMULATOR, id: 'runner-session-proxy-takeover-sim' };
  writeRunnerLease(
    makeRunnerLease({
      deviceId: device.id,
      ownerToken: 'owner-foreign-proxy-live',
      ownerPid: process.pid,
      ownerStartTime: RUNNER_OWNER_START_TIME,
      ownerStateDir: '/tmp/agent-device-owner',
      runnerPid: 4_321,
    }),
  );

  const session = await ensureRunnerSession(device, {
    runnerLeaseContext: {
      tenantId: 'proxy',
      runId: 'run-456',
      leaseId: 'lease-789',
      leaseProvider: 'proxy',
      clientId: 'client-a',
      deviceKey: `ios:mobile:${device.id}`,
    },
  });

  assert.equal(session.deviceId, device.id);
  assert.equal(mockRunCmdBackground.mock.calls.length, 1);
  const pkillCalls = mockRunAppleToolCommand.mock.calls.filter(isXcodebuildPkillCall);
  assert.ok(pkillCalls.length >= 2);
  assert.match(String(pkillCalls[0]?.[1]?.[2] ?? ''), /owner-foreign-proxy-live/);
});

test('runner session startup reclaims live foreign runner lease from same state dir', async () => {
  const device = { ...IOS_SIMULATOR, id: 'runner-session-same-state-lease-sim' };
  const previousStateDir = process.env.AGENT_DEVICE_STATE_DIR;
  const stateDir = '/tmp/agent-device-proxy-state';
  process.env.AGENT_DEVICE_STATE_DIR = stateDir;
  writeRunnerLease(
    makeRunnerLease({
      deviceId: device.id,
      ownerToken: 'owner-foreign-same-state',
      ownerPid: process.pid,
      ownerStartTime: RUNNER_OWNER_START_TIME,
      ownerStateDir: stateDir,
      runnerPid: 4_321,
    }),
  );

  try {
    const session = await ensureRunnerSession(device, {});

    assert.equal(session.deviceId, device.id);
    assert.equal(mockRunCmdBackground.mock.calls.length, 1);
    assert.deepEqual(mockCleanupTempFile.mock.calls, [
      [`/tmp/AgentDeviceRunner.env.session-${device.id}-owner-foreign-same-state-8123.xctestrun`],
      [`/tmp/AgentDeviceRunner.env.session-${device.id}-owner-foreign-same-state-8123.json`],
    ]);
    const pkillCalls = mockRunAppleToolCommand.mock.calls.filter(isXcodebuildPkillCall);
    assert.ok(pkillCalls.length >= 2);
    assert.match(String(pkillCalls[0]?.[1]?.[2] ?? ''), /owner-foreign-same-state/);
  } finally {
    if (previousStateDir === undefined) delete process.env.AGENT_DEVICE_STATE_DIR;
    else process.env.AGENT_DEVICE_STATE_DIR = previousStateDir;
  }
});

test('runner session startup reclaims same-state live lease from daemon runtime owner state dir', async () => {
  const device = { ...IOS_SIMULATOR, id: 'runner-session-runtime-state-lease-sim' };
  const previousStateDir = process.env.AGENT_DEVICE_STATE_DIR;
  const stateDir = '/tmp/agent-device-runtime-state';
  delete process.env.AGENT_DEVICE_STATE_DIR;
  setRunnerLeaseOwnerStateDir(stateDir);
  writeRunnerLease(
    makeRunnerLease({
      deviceId: device.id,
      ownerToken: 'owner-foreign-runtime-state',
      ownerPid: process.pid,
      ownerStartTime: RUNNER_OWNER_START_TIME,
      ownerStateDir: stateDir,
      runnerPid: 4_321,
    }),
  );

  try {
    const session = await ensureRunnerSession(device, {});

    assert.equal(session.deviceId, device.id);
    assert.equal(mockRunCmdBackground.mock.calls.length, 1);
    const pkillCalls = mockRunAppleToolCommand.mock.calls.filter(isXcodebuildPkillCall);
    assert.ok(pkillCalls.length >= 2);
    assert.match(String(pkillCalls[0]?.[1]?.[2] ?? ''), /owner-foreign-runtime-state/);
  } finally {
    setRunnerLeaseOwnerStateDir(undefined);
    if (previousStateDir === undefined) delete process.env.AGENT_DEVICE_STATE_DIR;
    else process.env.AGENT_DEVICE_STATE_DIR = previousStateDir;
  }
});

test('runner session startup reclaims dead foreign runner lease before launching', async () => {
  const device = { ...IOS_SIMULATOR, id: 'runner-session-dead-lease-sim' };
  mockIsProcessAlive.mockImplementation((pid) => pid !== 999_999_999 && pid !== 999_999_998);
  writeRunnerLease(
    makeRunnerLease({
      deviceId: device.id,
      ownerToken: 'owner-dead-foreign',
      ownerPid: 999_999_999,
      runnerPid: 999_999_998,
    }),
  );

  const session = await ensureRunnerSession(device, {});

  assert.equal(session.deviceId, device.id);
  assert.equal(mockRunCmdBackground.mock.calls.length, 1);
  const pkillCalls = mockRunAppleToolCommand.mock.calls.filter(isXcodebuildPkillCall);
  assert.ok(pkillCalls.length >= 2);
  assert.match(
    String(pkillCalls[0]?.[1]?.[2] ?? ''),
    /xcodebuild\.\*test-without-building\.\*AgentDeviceRunner\\\.env\\\.session-runner-session-dead-lease-sim-owner-dead-foreign-/,
  );
});

test('runner lease cleanup reclaims only leases owned by the stopped daemon', async () => {
  const ownerPid = 999_999_991;
  const ownerStartTime = 'Fri Jun 19 12:00:00 2026';
  const owned = makeRunnerLease({
    deviceId: 'runner-session-clean-owned-lease',
    ownerPid,
    ownerStartTime,
    ownerToken: 'owner-clean-owned',
  });
  const foreign = makeRunnerLease({
    deviceId: 'runner-session-clean-foreign-lease',
    ownerPid,
    ownerStartTime: 'Fri Jun 19 12:01:00 2026',
    ownerToken: 'owner-clean-foreign',
  });
  writeRunnerLease(owned);
  writeRunnerLease(foreign);

  await cleanupRunnerLeasesForOwner(
    { pid: ownerPid, startTime: ownerStartTime },
    {
      cleanupRunnerProcessTree: async () => {},
      cleanupRunnerXcodebuildProcesses: async () => {},
      cleanupTempFile: mockCleanupTempFile,
    },
  );

  const leaseDir = process.env.AGENT_DEVICE_IOS_RUNNER_LEASE_DIR;
  assert.ok(leaseDir);
  assert.equal(fs.existsSync(path.join(leaseDir, `${owned.deviceId}.json`)), false);
  assert.equal(fs.existsSync(path.join(leaseDir, `${foreign.deviceId}.json`)), true);
  assert.deepEqual(mockCleanupTempFile.mock.calls, [[owned.xctestrunPath], [owned.jsonPath]]);
});

test('runner session restarts alive runner when expected xctestrun artifact changes', async () => {
  const device = { ...IOS_SIMULATOR, id: 'runner-session-stale-artifact-sim' };

  mockEnsureXctestrunArtifact
    .mockResolvedValueOnce({
      xctestrunPath: '/tmp/base-runner.xctestrun',
      derived: '/tmp/derived',
      cache: 'miss',
      artifact: 'rebuilt',
      buildMs: 12,
      xctestrunPathSource: 'build',
    })
    .mockResolvedValueOnce({
      xctestrunPath: '/tmp/base-runner-next.xctestrun',
      derived: '/tmp/derived-next',
      cache: 'miss',
      artifact: 'rebuilt',
      buildMs: 13,
      xctestrunPathSource: 'build',
    });

  const session = await ensureRunnerSession(device, {});
  mockResolveRunnerDerivedPath.mockReturnValue('/tmp/derived-next');
  const restarted = await ensureRunnerSession(device, {});

  assert.notEqual(restarted, session);
  assert.equal(restarted.xctestrunArtifact?.derived, '/tmp/derived-next');
  assert.equal(mockRunCmdBackground.mock.calls.length, 2);
});

test('runner session reuses external xctestrun artifact without cache-derived comparison', async () => {
  const device = { ...IOS_SIMULATOR, id: 'runner-session-external-artifact-sim' };
  mockEnsureXctestrunArtifact.mockResolvedValueOnce({
    xctestrunPath: '/tmp/aws/AgentDeviceRunner.xctestrun',
    derived: '/tmp/aws-derived',
    cache: 'external',
    artifact: 'valid',
    buildMs: 0,
    xctestrunPathSource: 'external',
  });

  const session = await ensureRunnerSession(device, {});
  mockResolveRunnerDerivedPath.mockReturnValue('/tmp/internal-cache-derived');
  const reused = await ensureRunnerSession(device, {});

  assert.equal(reused, session);
  assert.equal(mockRunCmdBackground.mock.calls.length, 1);
  assert.equal(mockEnsureXctestrunArtifact.mock.calls.length, 1);
});

test('runner session restarts dead runner without graceful shutdown', async () => {
  const device = { ...IOS_SIMULATOR, id: 'runner-session-dead-sim' };

  const session = await ensureRunnerSession(device, {});
  mockWaitForRunner.mockClear();
  mockIsProcessAlive.mockReturnValue(false);

  const restarted = await ensureRunnerSession(device, {});

  assert.notEqual(restarted, session);
  assert.equal(mockRunCmdBackground.mock.calls.length, 2);
  assert.equal(mockWaitForRunner.mock.calls.length, 0);
  assert.deepEqual(mockCleanupTempFile.mock.calls, [
    ['/tmp/session-runner.xctestrun'],
    ['/tmp/session-runner.json'],
  ]);
  assert.equal(mockRedirectRelease.mock.calls.length, 1);
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

test('runner session stop kills only owned stale xcodebuild runner processes without in-memory session', async () => {
  const deviceId = '11C70358-8331-4872-A0CA-F15B6859B6FC';
  writeRunnerLease(makeRunnerLease({ deviceId, ownerToken: RUNNER_OWNER_TOKEN }));

  await stopIosRunnerSession(deviceId);

  const pkillCalls = mockRunAppleToolCommand.mock.calls.filter(isXcodebuildPkillCall);
  assert.equal(pkillCalls.length, 2);
  assert.deepEqual(pkillCalls[0]?.[1]?.slice(0, 2), ['-TERM', '-f']);
  assert.deepEqual(pkillCalls[1]?.[1]?.slice(0, 2), ['-KILL', '-f']);
  assert.match(
    String(pkillCalls[0]?.[1]?.[2] ?? ''),
    /xcodebuild\.\*test-without-building\.\*AgentDeviceRunner\\\.env\\\.session-11C70358-8331-4872-A0CA-F15B6859B6FC-owner-\d+-/,
  );
  assert.deepEqual(pkillCalls[0]?.[2], {
    allowFailure: true,
    timeoutMs: 2_000,
  });
});

test('runner session abort removes owned lease for in-memory sessions', async () => {
  const device = { ...IOS_SIMULATOR, id: 'runner-session-abort-lease-sim' };
  const session = await ensureRunnerSession(device, {});
  const leaseDir = process.env.AGENT_DEVICE_IOS_RUNNER_LEASE_DIR;
  assert.ok(leaseDir);
  const leasePath = path.join(leaseDir, `${device.id}.json`);
  assert.equal(fs.existsSync(leasePath), true);

  await abortAllIosRunnerSessions();

  assert.equal(fs.existsSync(leasePath), false);
  assert.equal(getRunnerSessionSnapshot(session.deviceId), null);
  assert.deepEqual(mockCleanupTempFile.mock.calls, [
    ['/tmp/session-runner.xctestrun'],
    ['/tmp/session-runner.json'],
  ]);
  assert.equal(mockRedirectRelease.mock.calls.length, 1);
});

function isXcodebuildPkillCall(call: unknown[]): boolean {
  const args = call[1];
  return call[0] === 'pkill' && Array.isArray(args) && args.includes('-f');
}

function isDevToolsSecurityStatusCall(call: unknown[]): boolean {
  const args = call[1];
  return call[0] === 'DevToolsSecurity' && Array.isArray(args) && args[0] === '-status';
}

function mockDevToolsSecurityDisabled(): void {
  mockRunAppleToolCommand.mockImplementation(async (cmd, args) => {
    if (cmd === 'DevToolsSecurity' && args[0] === '-status') {
      return {
        exitCode: 0,
        stdout: 'Developer mode is currently disabled.\n',
        stderr: '',
      };
    }
    return { exitCode: 0, stdout: '', stderr: '' };
  });
}

test('runner session invalidation skips graceful shutdown and removes stale session', async () => {
  const device = { ...IOS_SIMULATOR, id: 'runner-session-invalidate-sim' };
  const session = await ensureRunnerSession(device, {});

  mockWaitForRunner.mockClear();
  await invalidateRunnerSession(session, 'transport_error_after_command_send');

  assert.equal(mockWaitForRunner.mock.calls.length, 0);
  assert.equal(
    mockRunAppleToolCommand.mock.calls.some((call) => call[0] === 'pkill'),
    true,
  );
  assert.deepEqual(mockCleanupTempFile.mock.calls, [
    ['/tmp/session-runner.xctestrun'],
    ['/tmp/session-runner.json'],
  ]);
  assert.equal(mockRedirectRelease.mock.calls.length, 1);
  assert.equal(getRunnerSessionSnapshot(device.id), null);
});

test('runner session validates supported Apple runner devices', () => {
  validateRunnerDevice({ ...IOS_SIMULATOR, platform: 'apple', kind: 'simulator' });
  validateRunnerDevice({
    ...IOS_SIMULATOR,
    id: 'runner-session-macos',
    platform: 'apple',
    appleOs: 'macos',
    kind: 'device',
    target: 'desktop',
  });
  assert.throws(
    () => validateRunnerDevice({ ...IOS_SIMULATOR, platform: 'android' }),
    /Unsupported platform/,
  );
  assert.throws(
    () => validateRunnerDevice({ ...IOS_SIMULATOR, kind: 'emulator' }),
    /Unsupported iOS device kind/,
  );
});

const ALLOWLISTED_MUTATIONS: { name: string; command: Record<string, unknown> }[] = [
  { name: 'tap', command: { command: 'tap', x: 120, y: 240 } },
  {
    name: 'selector tap',
    command: { command: 'tap', selectorKey: 'label', selectorValue: 'Open article' },
  },
  { name: 'longPress', command: { command: 'longPress', x: 1, y: 2 } },
  { name: 'drag', command: { command: 'drag', x: 1, y: 2, x2: 3, y2: 4 } },
  { name: 'swipe', command: { command: 'swipe', x: 1, y: 2, x2: 3, y2: 4 } },
  { name: 'scroll', command: { command: 'scroll', direction: 'down' } },
  { name: 'desktopScroll', command: { command: 'desktopScroll', direction: 'down' } },
  {
    name: 'sequence',
    command: { command: 'sequence', steps: [{ kind: 'tap', x: 120, y: 240 }] },
  },
];

for (const { name, command } of ALLOWLISTED_MUTATIONS) {
  test(`runner session skips readiness preflight for ${name} after a fresh same-bundle healthy mutation`, async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-11T00:00:00Z'));
    try {
      const session = makeRunnerSession({
        ready: true,
        lastHealthyMutation: { atMs: Date.now() - 1_500, appBundleId: 'com.example.demo' },
      });
      mockSendRunnerCommandOnce.mockResolvedValueOnce(runnerResponse({ acted: true }));

      const diagnostics = await captureDiagnostics(async () => {
        await executeRunnerCommandWithSession(
          IOS_SIMULATOR,
          session,
          { ...command, appBundleId: 'com.example.demo' } as Parameters<
            typeof executeRunnerCommandWithSession
          >[2],
          '/tmp/runner.log',
          30_000,
        );
      });

      assert.equal(mockWaitForRunner.mock.calls.length, 0);
      assert.equal(mockSendRunnerCommandOnce.mock.calls.length, 1);
      assert.match(diagnostics, /ios_runner_readiness_preflight_skipped/);
      assert.match(diagnostics, /"reason":"recent_healthy_mutation"/);
      assert.match(diagnostics, /"lastHealthyMutationAgeMs":1500/);
    } finally {
      vi.useRealTimers();
    }
  });
}

test('runner session records recency only from allowlisted healthy mutations', async () => {
  const session = makeRunnerSession({ ready: true });
  mockWaitForRunner.mockResolvedValueOnce(runnerResponse({ uptimeMs: 42 }));
  mockSendRunnerCommandOnce.mockResolvedValueOnce(runnerResponse({ tapped: true }));

  await executeRunnerCommandWithSession(
    IOS_SIMULATOR,
    session,
    { command: 'tap', x: 120, y: 240, appBundleId: 'com.example.demo' },
    '/tmp/runner.log',
    30_000,
  );

  assert.equal(session.lastHealthyMutation?.appBundleId, 'com.example.demo');
  assert.equal(typeof session.lastHealthyMutation?.atMs, 'number');

  // Second allowlisted command now skips preflight.
  mockWaitForRunner.mockClear();
  mockSendRunnerCommandOnce.mockResolvedValueOnce(runnerResponse({ tapped: true }));
  await executeRunnerCommandWithSession(
    IOS_SIMULATOR,
    session,
    { command: 'tap', x: 1, y: 2, appBundleId: 'com.example.demo' },
    '/tmp/runner.log',
    30_000,
  );
  assert.equal(mockWaitForRunner.mock.calls.length, 0);
});

test('runner session does not record recency from successful read-only responses', async () => {
  const session = makeRunnerSession({ ready: true });
  mockWaitForRunner
    .mockResolvedValueOnce(runnerResponse({ uptimeMs: 42 }))
    .mockResolvedValueOnce(runnerResponse({ nodes: [], truncated: false }));

  await executeRunnerCommandWithSession(
    IOS_SIMULATOR,
    session,
    { command: 'snapshot', appBundleId: 'com.example.demo' },
    '/tmp/runner.log',
    30_000,
  );

  assert.equal(session.lastHealthyMutation, undefined);

  // The next tap must still preflight because no healthy mutation was recorded.
  mockWaitForRunner.mockClear();
  mockWaitForRunner.mockResolvedValueOnce(runnerResponse({ uptimeMs: 42 }));
  mockSendRunnerCommandOnce.mockResolvedValueOnce(runnerResponse({ tapped: true }));
  await executeRunnerCommandWithSession(
    IOS_SIMULATOR,
    session,
    { command: 'tap', x: 1, y: 2, appBundleId: 'com.example.demo' },
    '/tmp/runner.log',
    30_000,
  );
  assert.equal(mockWaitForRunner.mock.calls.length, 1);
  assertRunnerCommand(mockWaitForRunner.mock.calls[0]?.[2], { command: 'uptime' });
});

test('runner session does not record recency from runnerFatal ok payloads', async () => {
  const session = makeRunnerSession({ ready: true });
  mockWaitForRunner.mockResolvedValueOnce(runnerResponse({ uptimeMs: 42 }));
  mockSendRunnerCommandOnce.mockResolvedValueOnce(
    runnerResponse({
      acted: false,
      runnerFatal: true,
      runnerFatalReason: 'ax_snapshot_unavailable',
    }),
  );

  await executeRunnerCommandWithSession(
    IOS_SIMULATOR,
    session,
    { command: 'tap', x: 1, y: 2, appBundleId: 'com.example.demo' },
    '/tmp/runner.log',
    30_000,
  );

  assert.equal(session.lastHealthyMutation, undefined);
});

test('runner session preflights with conservative_command for non-allowlisted mutations', async () => {
  const session = makeRunnerSession({
    ready: true,
    lastHealthyMutation: { atMs: Date.now(), appBundleId: 'com.example.demo' },
  });
  mockWaitForRunner.mockResolvedValueOnce(runnerResponse({ uptimeMs: 42 }));
  mockSendRunnerCommandOnce.mockResolvedValueOnce(runnerResponse({ typed: true }));

  const diagnostics = await captureDiagnostics(async () => {
    await executeRunnerCommandWithSession(
      IOS_SIMULATOR,
      session,
      { command: 'type', text: 'hi', appBundleId: 'com.example.demo' },
      '/tmp/runner.log',
      30_000,
    );
  });

  assert.equal(mockWaitForRunner.mock.calls.length, 1);
  assert.match(diagnostics, /"reason":"conservative_command"/);
});

test('runner session preflights with no_recent_healthy_mutation when ready without a record', async () => {
  const session = makeRunnerSession({ ready: true });
  mockWaitForRunner.mockResolvedValueOnce(runnerResponse({ uptimeMs: 42 }));
  mockSendRunnerCommandOnce.mockResolvedValueOnce(runnerResponse({ tapped: true }));

  const diagnostics = await captureDiagnostics(async () => {
    await executeRunnerCommandWithSession(
      IOS_SIMULATOR,
      session,
      { command: 'tap', x: 1, y: 2, appBundleId: 'com.example.demo' },
      '/tmp/runner.log',
      30_000,
    );
  });

  assert.equal(mockWaitForRunner.mock.calls.length, 1);
  assert.match(diagnostics, /"reason":"no_recent_healthy_mutation"/);
});

test('runner session preflights with healthy_mutation_stale when the record is older than 5s', async () => {
  const session = makeRunnerSession({
    ready: true,
    lastHealthyMutation: { atMs: Date.now() - 6_000, appBundleId: 'com.example.demo' },
  });
  mockWaitForRunner.mockResolvedValueOnce(runnerResponse({ uptimeMs: 42 }));
  mockSendRunnerCommandOnce.mockResolvedValueOnce(runnerResponse({ tapped: true }));

  const diagnostics = await captureDiagnostics(async () => {
    await executeRunnerCommandWithSession(
      IOS_SIMULATOR,
      session,
      { command: 'tap', x: 1, y: 2, appBundleId: 'com.example.demo' },
      '/tmp/runner.log',
      30_000,
    );
  });

  assert.equal(mockWaitForRunner.mock.calls.length, 1);
  assert.match(diagnostics, /"reason":"healthy_mutation_stale"/);
});

test('runner session preflights with app_activation_uncertain on a differing bundle', async () => {
  const session = makeRunnerSession({
    ready: true,
    lastHealthyMutation: { atMs: Date.now(), appBundleId: 'com.example.demo' },
  });
  mockWaitForRunner.mockResolvedValueOnce(runnerResponse({ uptimeMs: 42 }));
  mockSendRunnerCommandOnce.mockResolvedValueOnce(runnerResponse({ tapped: true }));

  const diagnostics = await captureDiagnostics(async () => {
    await executeRunnerCommandWithSession(
      IOS_SIMULATOR,
      session,
      { command: 'tap', x: 1, y: 2, appBundleId: 'com.example.other' },
      '/tmp/runner.log',
      30_000,
    );
  });

  assert.equal(mockWaitForRunner.mock.calls.length, 1);
  assert.match(diagnostics, /"reason":"app_activation_uncertain"/);
});

test('runner session preflights with startup reason for the first command on a fresh session', async () => {
  const session = makeRunnerSession({
    ready: false,
    lastHealthyMutation: { atMs: Date.now(), appBundleId: 'com.example.demo' },
  });
  mockWaitForRunner.mockResolvedValueOnce(runnerResponse({ uptimeMs: 42 }));
  mockSendRunnerCommandOnce.mockResolvedValueOnce(runnerResponse({ tapped: true }));

  const diagnostics = await captureDiagnostics(async () => {
    await executeRunnerCommandWithSession(
      IOS_SIMULATOR,
      session,
      { command: 'tap', x: 1, y: 2, appBundleId: 'com.example.demo' },
      '/tmp/runner.log',
      30_000,
    );
  });

  assert.equal(mockWaitForRunner.mock.calls.length, 1);
  assert.match(diagnostics, /"reason":"startup"/);
});

test('runner session clears recency and marks the error when a skipped-preflight send fails', async () => {
  const session = makeRunnerSession({
    ready: true,
    lastHealthyMutation: { atMs: Date.now() - 1_000, appBundleId: 'com.example.demo' },
  });
  mockSendRunnerCommandOnce.mockRejectedValueOnce(new Error('fetch failed'));

  await assert.rejects(
    () =>
      executeRunnerCommandWithSession(
        IOS_SIMULATOR,
        session,
        { command: 'tap', x: 1, y: 2, appBundleId: 'com.example.demo' },
        '/tmp/runner.log',
        30_000,
      ),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.details?.runnerReadinessPreflightSkipped, true);
      assert.equal(error.details?.runnerReadinessPreflightSkipReason, 'recent_healthy_mutation');
      assert.equal(typeof error.details?.runnerReadinessPreflightSkippedAgeMs, 'number');
      assert.notEqual(error.details?.runnerReadinessPreflightFailed, true);
      return true;
    },
  );

  assert.equal(mockWaitForRunner.mock.calls.length, 0);
  assert.equal(session.lastHealthyMutation, undefined);
});

test('runner session does not mark structured runner failures after a skip as skipped-preflight', async () => {
  const session = makeRunnerSession({
    ready: true,
    lastHealthyMutation: { atMs: Date.now() - 1_000, appBundleId: 'com.example.demo' },
  });
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
        { command: 'tap', x: 1, y: 2, appBundleId: 'com.example.demo' },
        '/tmp/runner.log',
        30_000,
      ),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.message, 'Runner failed after receiving command');
      assert.notEqual(error.details?.runnerReadinessPreflightSkipped, true);
      return true;
    },
  );
});

test('runner session clears recency when an allowlisted command returns XCTest recorded failure', async () => {
  const device = { ...IOS_SIMULATOR, id: 'runner-session-skip-xctest-failure-sim' };
  const session = await ensureRunnerSession(device, {});
  session.ready = true;
  session.lastHealthyMutation = { atMs: Date.now() - 1_000, appBundleId: 'com.example.demo' };
  mockWaitForRunner.mockClear();
  mockSendRunnerCommandOnce.mockResolvedValueOnce(
    runnerError({
      code: 'XCTEST_RECORDED_FAILURE',
      message: 'XCTest recorded a failure while executing tap.',
    }),
  );

  await assert.rejects(
    () =>
      executeRunnerCommandWithSession(
        device,
        session,
        { command: 'tap', x: 1, y: 2, appBundleId: 'com.example.demo' },
        '/tmp/runner.log',
        30_000,
      ),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, 'XCTEST_RECORDED_FAILURE');
      return true;
    },
  );

  assert.equal(session.lastHealthyMutation, undefined);
  assert.equal(getRunnerSessionSnapshot(device.id), null);
});

function makeRunnerSession(overrides: Partial<RunnerSession> = {}): RunnerSession {
  return {
    sessionId: `session-${overrides.port ?? 8100}`,
    device: IOS_SIMULATOR,
    deviceId: IOS_SIMULATOR.id,
    port: 8100,
    xctestrunPath: '/tmp/runner.xctestrun',
    jsonPath: '/tmp/runner.json',
    testPromise: Promise.resolve({ exitCode: 0, stdout: '', stderr: '' }),
    child: { pid: 1234, exitCode: null },
    ready: true,
    ...overrides,
  } as RunnerSession;
}

function makeRunnerLease(
  overrides: Partial<RunnerLease> & { deviceId: string; ownerToken?: string | undefined },
): RunnerLease {
  const ownerToken = overrides.ownerToken ?? `owner-${process.pid}-test`;
  const lease: RunnerLease = {
    schemaVersion: 1,
    deviceId: overrides.deviceId,
    ownerToken,
    ownerPid: process.pid,
    ownerStartTime: RUNNER_OWNER_START_TIME,
    sessionId: `session-${overrides.deviceId}`,
    runnerPid: 4242,
    port: 8123,
    xctestrunPath: `/tmp/AgentDeviceRunner.env.session-${overrides.deviceId}-${ownerToken}-8123.xctestrun`,
    jsonPath: `/tmp/AgentDeviceRunner.env.session-${overrides.deviceId}-${ownerToken}-8123.json`,
    createdAtMs: Date.now(),
  };
  return { ...lease, ...overrides, ownerToken };
}

function makeBackgroundRunner(pid: number) {
  return {
    child: {
      pid,
      exitCode: null,
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
    },
    wait: Promise.resolve({ exitCode: 0, stdout: '', stderr: '' }),
  };
}

function runnerResponse(data: Record<string, unknown>): Response {
  return new Response(JSON.stringify({ ok: true, data }));
}

function runnerError(error: { code: string; message: string }): Response {
  return new Response(JSON.stringify({ ok: false, error }));
}

async function captureDiagnostics(callback: () => Promise<void>): Promise<string> {
  const previousHome = process.env.HOME;
  process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-runner-diag-'));
  try {
    return await withDiagnosticsScope(
      { session: 'runner-session-test', requestId: 'request-1', command: 'tap' },
      async () => {
        await callback();
        const diagnosticsPath = flushDiagnosticsToSessionFile({ force: true });
        assert.ok(diagnosticsPath);
        return fs.readFileSync(diagnosticsPath, 'utf8');
      },
    );
  } finally {
    process.env.HOME = previousHome;
  }
}

function assertRunnerCommand(
  actual: unknown,
  expected: Record<string, unknown>,
  options: { commandId?: boolean } = {},
): asserts actual is Record<string, unknown> {
  assert.equal(typeof actual, 'object');
  assert.notEqual(actual, null);
  const command = actual as Record<string, unknown>;
  const commandId = command.commandId;
  if (options.commandId === false) {
    assert.equal(commandId, undefined);
    assert.deepEqual(command, expected);
    return;
  }
  if (typeof commandId !== 'string') {
    assert.fail('expected runner commandId');
  }
  assert.match(commandId, /^runner-/);
  assert.deepEqual({ ...command, commandId: undefined }, { ...expected, commandId: undefined });
}
