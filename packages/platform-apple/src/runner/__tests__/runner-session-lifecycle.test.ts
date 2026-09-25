import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, test, vi } from 'vitest';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { IOS_DEVICE, IOS_SIMULATOR, MACOS_DEVICE } from './device-fixtures.ts';
import { appleRunnerTestHost } from '../test-host.ts';
import { resolveRunnerLaunchLogPath } from '../runner-io.ts';
import type { RunnerSession } from '../runner-session-types.ts';
import {
  captureDiagnostics,
  makeClassifyOwnerLivenessViaMocks,
  assertRunnerCommand,
  makeBackgroundRunner,
  runnerResponse,
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
  runnerStateTransitions,
} = vi.hoisted(() => ({
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
  detachIosRunnerSessionsForShutdown,
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
  const session = await ensureRunnerSession(device, {});
  await serveOneCommand(device, session);
  const runnerPid = session.child.pid;
  assert.ok(runnerPid);
  runnerStateTransitions.length = 0;

  assert.equal(await detachIosRunnerSessionsForShutdown(), 1);

  assert.equal(session.state, 'stopped');
  assert.deepEqual(runnerStateTransitions, ['stopped']);
  assert.equal(readRunnerSessionLiveness(device.id), null);
  assert.equal(mockIsProcessAlive(runnerPid), true);
  assert.match(leaseRaw(device.id), /"ownerToken": "detached-owner-/);
});

test('a scoped simulator-set session hands off like one in the default set', async () => {
  const device = {
    ...IOS_SIMULATOR,
    id: 'runner-lifecycle-detach-scoped-sim',
    simulatorSetPath: '/tmp/custom-device-set',
  };
  const session = await ensureRunnerSession(device, {});
  await serveOneCommand(device, session);

  assert.equal(await detachIosRunnerSessionsForShutdown(), 1);

  assert.equal(session.state, 'stopped');
  assert.match(leaseRaw(device.id), /"ownerToken": "detached-owner-/);
});

// #2681: the handoff lanes and every gate that keeps a runner on the kill path.
async function serveOneCommand(device: DeviceInfo, session: RunnerSession): Promise<void> {
  mockWaitForRunner.mockResolvedValueOnce(runnerResponse({ nodes: [], truncated: false }));
  await executeRunnerCommandWithSession(
    device,
    session,
    { command: 'snapshot', appBundleId: 'com.example.demo' },
    '/tmp/runner.log',
    30_000,
  );
}

function leaseRaw(deviceId: string): string {
  return fs.readFileSync(
    path.join(process.env.AGENT_DEVICE_IOS_RUNNER_LEASE_DIR ?? '', `${deviceId}.json`),
    'utf8',
  );
}

test('a runner that served a command is handed off on the physical lane', async () => {
  const device: DeviceInfo = { ...IOS_DEVICE, id: 'runner-lifecycle-detach-device' };
  const session = await ensureRunnerSession(device, {});
  await serveOneCommand(device, session);
  runnerStateTransitions.length = 0;

  const diagnostics = await captureDiagnostics(async () => {
    assert.equal(await detachIosRunnerSessionsForShutdown(), 1);
  });

  assert.equal(session.state, 'stopped');
  assert.equal(readRunnerSessionLiveness(device.id), null);
  assert.match(leaseRaw(device.id), /"ownerToken": "detached-owner-/);
  assert.match(diagnostics, /"phase":"ios_runner_session_detached"/);
  assert.match(diagnostics, /"lane":"physical_coredevice"/);

  // What a client of the next daemon is told to read, so the handoff must name the file and keep it
  // writable by the runner this process no longer follows (#2681).
  const runnerLogPath = resolveRunnerLaunchLogPath(undefined, device.id);
  assert.ok(diagnostics.includes(`"runnerLogPath":${JSON.stringify(runnerLogPath)}`));
  fs.appendFileSync(runnerLogPath, 'written after the handoff\n');
  assert.match(fs.readFileSync(runnerLogPath, 'utf8'), /written after the handoff/);
});

test('a runner that never served a command is torn down instead of handed off', async () => {
  // Physical startup runs tens of seconds: handing off a runner that never reached its listener
  // would give the next daemon a lease over a process that may not be serving at all.
  const device: DeviceInfo = { ...IOS_DEVICE, id: 'runner-lifecycle-shutdown-mid-startup' };
  const session = await ensureRunnerSession(device, {});
  assert.equal(session.state, 'starting');

  const diagnostics = await captureDiagnostics(async () => {
    assert.equal(await detachIosRunnerSessionsForShutdown(), 0);
  });

  assert.deepEqual(readRunnerSessionLiveness(device.id), {
    sessionId: session.sessionId,
    liveness: 'starting',
  });
  assert.match(diagnostics, /"reason":"runner_never_served_a_command"/);

  // The shutdown's own stop path, which runs right after the detach pass, is what tears it down.
  await abortAllIosRunnerSessions();
  assert.equal(session.state, 'stopped');
  assert.equal(readRunnerSessionLiveness(device.id), null);
});

test('a runner reporting main-thread work still draining is not handed off', async () => {
  const device: DeviceInfo = { ...IOS_DEVICE, id: 'runner-lifecycle-detach-busy' };
  const session = await ensureRunnerSession(device, {});
  mockWaitForRunner.mockResolvedValueOnce(
    runnerResponse({ nodes: [], truncated: false, runnerMainThreadBusy: true }),
  );
  await executeRunnerCommandWithSession(
    device,
    session,
    { command: 'snapshot', appBundleId: 'com.example.demo' },
    '/tmp/runner.log',
    30_000,
  );
  assert.equal(session.state, 'ready');

  const diagnostics = await captureDiagnostics(async () => {
    assert.equal(await detachIosRunnerSessionsForShutdown(), 0);
  });

  assert.match(diagnostics, /"reason":"main_thread_occupied"/);
  assert.ok(readRunnerSessionLiveness(device.id));
});

test('a session that still owes a response is not handed off', async () => {
  // The occupancy mirror only describes the last COMPLETED exchange, so a command abandoned while the
  // runner holds it would otherwise hand off a runner with work on its main thread (#2681).
  const device: DeviceInfo = { ...IOS_DEVICE, id: 'runner-lifecycle-detach-in-flight' };
  const session = await ensureRunnerSession(device, {});
  await serveOneCommand(device, session);
  // `terminate` answers the preflight gate itself, so the only exchange left hanging is the one the
  // runner is holding.
  mockSendRunnerCommandOnce.mockImplementation(
    () => new Promise<Response>(() => {}) as Promise<Response>,
  );
  const inFlight = executeRunnerCommandWithSession(
    device,
    session,
    { command: 'terminate', appBundleId: 'com.example.demo' },
    '/tmp/runner.log',
    30_000,
  );
  void inFlight.catch(() => {});
  // The charge lands behind the preflight and deadline awaits, so wait for it instead of betting on a
  // single macrotask: a loaded runner can sit anywhere on that path, and a session that had not been
  // charged yet would look identical to one whose charge was wrongly dropped (#2681).
  for (let tick = 0; tick < 500 && session.inFlightCommands === 0; tick += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  assert.equal(session.inFlightCommands, 1);

  const diagnostics = await captureDiagnostics(async () => {
    assert.equal(await detachIosRunnerSessionsForShutdown(), 0);
  });

  assert.match(diagnostics, /"reason":"command_in_flight"/);
  assert.ok(readRunnerSessionLiveness(device.id));
});

test('a command abandoned by a cancelled transport keeps the runner occupied', async () => {
  // Cancelling ends every wait this side holds, but the runner is still executing what it took, so a
  // shutdown that read only live waits would hand off a runner with work on its main thread. The
  // charge is sticky until an answered exchange proves the runner serves requests again (#2681).
  const device: DeviceInfo = { ...IOS_DEVICE, id: 'runner-lifecycle-detach-abandoned' };
  const session = await ensureRunnerSession(device, {});
  await serveOneCommand(device, session);
  const controller = new AbortController();
  mockSendRunnerCommandOnce.mockImplementationOnce(async () => {
    controller.abort();
    throw new Error('Request was aborted');
  });

  await assert.rejects(
    executeRunnerCommandWithSession(
      device,
      session,
      { command: 'terminate', appBundleId: 'com.example.demo' },
      '/tmp/runner.log',
      30_000,
      controller.signal,
    ),
  );
  assert.equal(session.hasAbandonedCommands, true);

  const refused = await captureDiagnostics(async () => {
    assert.equal(await detachIosRunnerSessionsForShutdown(), 0);
  });
  assert.match(refused, /"reason":"command_in_flight"/);

  // Any answered exchange forgives the abandoned charge: the runner is serving again, and stamps
  // whatever is still draining onto that very reply.
  await serveOneCommand(device, session);
  assert.equal(session.inFlightCommands, 0);
  assert.equal(session.hasAbandonedCommands, false);
  assert.equal(await detachIosRunnerSessionsForShutdown(), 1);
});

test('the macOS host runner is never handed off, although it is kind device', async () => {
  const device: DeviceInfo = { ...MACOS_DEVICE, id: 'runner-lifecycle-detach-macos' };
  const session = await ensureRunnerSession(device, {});
  await serveOneCommand(device, session);

  const diagnostics = await captureDiagnostics(async () => {
    assert.equal(await detachIosRunnerSessionsForShutdown(), 0);
  });

  assert.match(diagnostics, /"reason":"macos_host"/);
  assert.ok(readRunnerSessionLiveness(device.id));
});

test('a physical tvOS runner is never handed off, although it is kind device too', async () => {
  const device: DeviceInfo = {
    ...IOS_DEVICE,
    id: 'runner-lifecycle-detach-tv-device',
    name: 'Apple TV',
    target: 'tv',
    appleOs: 'tvos',
  };
  const session = await ensureRunnerSession(device, {});
  await serveOneCommand(device, session);

  const diagnostics = await captureDiagnostics(async () => {
    assert.equal(await detachIosRunnerSessionsForShutdown(), 0);
  });

  assert.match(diagnostics, /"reason":"physical_non_ios_os"/);
  assert.ok(readRunnerSessionLiveness(device.id));
});

test('a usbmux-only xctest backend runner is never handed off', async () => {
  const device: DeviceInfo = {
    ...IOS_DEVICE,
    id: 'runner-lifecycle-detach-xctest-backend',
    iosPhysicalDeviceBackend: 'xctest',
  };
  const session = await ensureRunnerSession(device, {});
  await serveOneCommand(device, session);

  const diagnostics = await captureDiagnostics(async () => {
    assert.equal(await detachIosRunnerSessionsForShutdown(), 0);
  });

  assert.match(diagnostics, /"reason":"xctest_backend"/);
  assert.ok(readRunnerSessionLiveness(device.id));
});

test("the handoff releases this daemon's log bookkeeping only after the lease says so", async () => {
  const device: DeviceInfo = { ...IOS_DEVICE, id: 'runner-lifecycle-detach-order' };
  const session = await ensureRunnerSession(device, {});
  await serveOneCommand(device, session);
  // What a release done too early would show: the lease this callback reads back is still owned.
  const tokenWhenReleased: string[] = [];
  session.endOutputObservation = () => {
    tokenWhenReleased.push(leaseRaw(device.id));
  };

  assert.equal(await detachIosRunnerSessionsForShutdown(), 1);

  assert.equal(tokenWhenReleased.length, 1);
  assert.match(tokenWhenReleased[0]!, /"ownerToken": "detached-owner-/);
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

test('the same udid in another simulator set starts its own runner instead of reusing this one', async () => {
  const tenantA = {
    ...IOS_SIMULATOR,
    id: 'runner-lifecycle-two-sets',
    simulatorSetPath: '/tmp/tenant-a/simulators',
  };
  const tenantB = { ...tenantA, simulatorSetPath: '/tmp/tenant-b/simulators' };
  const first = await ensureRunnerSession(tenantA, {});
  assert.equal(await ensureRunnerSession({ ...tenantA }, {}), first);

  mockGetFreePort.mockResolvedValueOnce(8124);
  mockRunCmdBackground.mockReturnValueOnce(makeBackgroundRunner(4243));
  const second = await ensureRunnerSession(tenantB, {});

  assert.notEqual(second.sessionId, first.sessionId);
  assert.equal(first.state, 'stopped');
  assert.equal(second.device.simulatorSetPath, '/tmp/tenant-b/simulators');
  assert.match(leaseRaw(tenantB.id), /"simulatorSetPath": "\/tmp\/tenant-b\/simulators"/);
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
