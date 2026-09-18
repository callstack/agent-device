import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, test, vi } from 'vitest';
import type { AppleApplicationTools } from '@agent-device/contracts/application-lifecycle-runtime';
import type { PlatformRuntimeHost } from '@agent-device/contracts/platform-runtime-operations';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { IOS_SIMULATOR } from './device-fixtures.ts';
import { appleRunnerTestHost } from '../test-host.ts';
import {
  captureDiagnostics,
  makeClassifyOwnerLivenessViaMocks,
  makeBackgroundRunner,
  makeRunnerLease,
  runnerError,
  runnerResponse,
  redirectHandle,
} from './runner-session-fixtures.ts';
import { mkdtempForTestSync } from './tmp-dir.ts';
import { bindAppleApplicationLifecycle } from '../../lifecycle.ts';
import { platformRuntimeHostFixture } from '../../runtime.fixtures.ts';
import { runnerOwnerToken, writeRunnerLease } from '../runner-lease.ts';
import {
  abortAllIosRunnerSessions,
  ensureRunnerSession,
  executeRunnerCommandWithSession,
  readRunnerSessionLiveness,
  releaseIosRunnerOnClose,
  stopIosRunnerSession,
  type RunnerSession,
} from '../runner-session.ts';

// The close-finalization seam, end to end: Apple's real `finalizeApplicationClose` over the real
// runner module, composed the way the root's lazy `AppleApplicationTools` composes it. `lifecycle.test.ts`
// pins the intent lifecycle supplies; `runner-session-close.test.ts` pins the occupancy stamps and the
// disposal the decision reads. This file owns the truth table between them (#2615): the reuse intent
// crosses once, the runner module decides, and no runner state is inspected on the way.
// It lives in the runner family because that is the lane whose setup installs the real host
// capabilities behind the package's runner host port (`scripts/vitest-apple-runner-host-setup.ts`).

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

// Long enough that no case here can watch it fire: a retained close must arm the idle stop, and
// the non-retained close that must cancel it proves itself by the absence of the
// `ios_runner_idle_stop` phase under a window short enough to elapse inside one case.
const IDLE_WINDOW_OUTLIVES_RUN_MS = '600000';

let stateDir: string;

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
    'agent-device-close-finalize-',
  );
  process.env.AGENT_DEVICE_IOS_RUNNER_IDLE_STOP_MS = IDLE_WINDOW_OUTLIVES_RUN_MS;
  stateDir = mkdtempForTestSync('agent-device-close-finalize-state-');
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
  // A fresh Response per call: a fetch body is single-read, and a shared instance would be
  // consumed by the first readiness preflight of a file that sends more than one command.
  mockWaitForRunner.mockImplementation(async () => runnerResponse({ uptimeMs: 1 }));
});

test('a retained close over an idle runner keeps that runner warm for the next open (#2615)', async () => {
  const device = deviceNamed('close-finalize-warm-reuse');
  const session = await ensureRunnerSession(device, {});
  const events: string[] = [];
  const lifecycle = closeFinalizationLifecycle(device, events);

  const diagnostics = await captureDiagnostics(async () => {
    await lifecycle.finalizeApplicationClose(closeInput(true));
  });

  assert.deepEqual(events, ['release', 'released', 'alerts']);
  assert.match(diagnostics, /"phase":"ios_runner_idle_stop_scheduled"/);
  assert.doesNotMatch(diagnostics, /ios_runner_retain_skipped_busy/);
  assert.equal(readRunnerSessionLiveness(device.id)?.sessionId, session.sessionId);
  assert.ok(runnerLeaseExists(device.id));
  // The next open gets the same runner and launches nothing.
  assert.equal((await ensureRunnerSession(device, {})).sessionId, session.sessionId);
  assert.equal(mockRunCmdBackground.mock.calls.length, 1);
});

test('a retained close disposes a runner still draining so the next open boots a clean one (#2552, #2615)', async () => {
  const device = deviceNamed('close-finalize-busy-dispose');
  const session = await ensureRunnerSession(device, {});
  await refuseWithRunnerBusy(device, session);
  const events: string[] = [];
  const lifecycle = closeFinalizationLifecycle(device, events);

  const diagnostics = await captureDiagnostics(async () => {
    await lifecycle.finalizeApplicationClose(closeInput(true));
  });

  assert.deepEqual(events, ['release', 'released', 'alerts']);
  assert.match(diagnostics, /"phase":"ios_runner_retain_skipped_busy"/);
  assert.doesNotMatch(diagnostics, /"phase":"ios_runner_idle_stop_scheduled"/);
  assert.equal(readRunnerSessionLiveness(device.id), null);
  assert.equal(runnerLeaseExists(device.id), false);
  assert.notEqual((await ensureRunnerSession(device, {})).sessionId, session.sessionId);
  assert.equal(mockRunCmdBackground.mock.calls.length, 2);
});

test('a non-retained close stops the runner and cancels the idle stop a retained close armed (#2615)', async () => {
  const device = deviceNamed('close-finalize-cancel-idle');
  await ensureRunnerSession(device, {});
  const lifecycle = closeFinalizationLifecycle(device, []);
  process.env.AGENT_DEVICE_IOS_RUNNER_IDLE_STOP_MS = '40';

  const diagnostics = await captureDiagnostics(async () => {
    await lifecycle.finalizeApplicationClose(closeInput(true));
    await lifecycle.finalizeApplicationClose(closeInput(false));
    // Past the window the first close armed: an uncancelled timer would stop the already
    // released runner and report `ios_runner_idle_stop`.
    await new Promise((resolve) => setTimeout(resolve, 150));
  });

  assert.match(diagnostics, /"phase":"ios_runner_idle_stop_scheduled"/);
  assert.doesNotMatch(diagnostics, /"phase":"ios_runner_idle_stop"/);
  assert.equal(readRunnerSessionLiveness(device.id), null);
  assert.equal(runnerLeaseExists(device.id), false);
});

test('a non-retained close releases an owned runner lease with no runner in memory (#2615)', async () => {
  const device = deviceNamed('close-finalize-orphan-lease');
  // A runner that already left the session map but whose lease this process still owns:
  // the unconditional stop owns that durable cleanup, so close must still await it.
  writeRunnerLease(makeRunnerLease({ deviceId: device.id, ownerToken: runnerOwnerToken() }));
  const lifecycle = closeFinalizationLifecycle(device, []);

  const diagnostics = await captureDiagnostics(async () => {
    await lifecycle.finalizeApplicationClose(closeInput(false));
  });

  assert.match(diagnostics, /"phase":"ios_runner_lease_cleanup"/);
  assert.match(diagnostics, /"reason":"owned"/);
  assert.equal(runnerLeaseExists(device.id), false);
  assert.equal(mockRunCmdBackground.mock.calls.length, 0);
});

test('a retained close with no runner in memory starts none and claims no lease (#2615)', async () => {
  const device = deviceNamed('close-finalize-no-runner-retain');
  const events: string[] = [];
  const lifecycle = closeFinalizationLifecycle(device, events);

  await lifecycle.finalizeApplicationClose(closeInput(true));

  assert.deepEqual(events, ['release', 'released', 'alerts']);
  assert.equal(readRunnerSessionLiveness(device.id), null);
  assert.equal(mockRunCmdBackground.mock.calls.length, 0);
  assert.equal(runnerLeaseExists(device.id), false);
});

test('a daemon-shutdown close never issues the ordinary close release (#2615)', async () => {
  const device = deviceNamed('close-finalize-daemon-shutdown');
  const session = await ensureRunnerSession(device, {});
  const events: string[] = [];
  const lifecycle = closeFinalizationLifecycle(device, events);

  await lifecycle.finalizeApplicationClose({ ...closeInput(true), daemonShutdown: true });

  assert.deepEqual(events, ['alerts']);
  assert.equal(readRunnerSessionLiveness(device.id)?.sessionId, session.sessionId);
  assert.ok(runnerLeaseExists(device.id));
});

test('a runner disposal failure propagates out of close before close alerts run (#2615)', async () => {
  const device = deviceNamed('close-finalize-disposal-rejects');
  await ensureRunnerSession(device, {});
  mockCleanupTempFile.mockImplementation(() => {
    throw new Error('runner artifact cleanup failed');
  });
  const events: string[] = [];
  const lifecycle = closeFinalizationLifecycle(device, events);

  await assert.rejects(
    () => lifecycle.finalizeApplicationClose(closeInput(false)),
    /runner artifact cleanup failed/,
  );

  // The awaited release is the gate: alerts belong to a close that finished releasing.
  assert.deepEqual(events, ['release']);
});

test('a drain that lands after close is issued cannot return a busy runner to reuse (#2615)', async () => {
  const device = deviceNamed('close-finalize-queued-drain');
  const session = await ensureRunnerSession(device, {});
  await refuseWithRunnerBusy(device, session);
  // Hold the disposal open so a served reply that clears occupancy lands while close is in
  // flight, rather than counting microtasks around the check.
  let settleRunnerExit: (result: {
    exitCode: number;
    stdout: string;
    stderr: string;
  }) => void = () => {};
  session.testPromise = new Promise((resolve) => {
    settleRunnerExit = resolve;
  });
  const events: string[] = [];
  const lifecycle = closeFinalizationLifecycle(device, events);

  const diagnostics = await captureDiagnostics(async () => {
    const draining = drainRunnerMainThread(device, session);
    const closing = lifecycle.finalizeApplicationClose(closeInput(true));
    settleRunnerExit({ exitCode: 0, stdout: '', stderr: '' });
    await closing;
    await draining;
  });

  assert.equal(session.runnerMainThreadBusy, false);
  assert.match(diagnostics, /"phase":"ios_runner_retain_skipped_busy"/);
  assert.doesNotMatch(diagnostics, /"phase":"ios_runner_idle_stop_scheduled"/);
  assert.equal(readRunnerSessionLiveness(device.id), null);
});

/** The close path's Apple tools, composed exactly as the root's lazy tools compose them. */
function closeFinalizationLifecycle(
  device: DeviceInfo,
  events: string[],
): ReturnType<typeof bindAppleApplicationLifecycle> {
  const dismissCloseAlerts: AppleApplicationTools['dismissCloseAlerts'] = async () => {
    events.push('alerts');
  };
  const baseHost = platformRuntimeHostFixture();
  const host = {
    ...baseHost,
    appleApplications: {
      ...baseHost.appleApplications,
      stopRunnerSession: async (deviceId: string) => {
        await stopIosRunnerSession(deviceId);
      },
      releaseRunnerOnClose: async (deviceId: string, options: { retain: boolean }) => {
        events.push('release');
        await releaseIosRunnerOnClose(deviceId, options);
        events.push('released');
      },
      dismissCloseAlerts,
    },
  } as unknown as PlatformRuntimeHost;
  return bindAppleApplicationLifecycle({ host, device, signal: new AbortController().signal });
}

function closeInput(retainRunner: boolean) {
  return { surface: 'app' as const, retainRunner, stateDir };
}

/** A command refused with `RUNNER_BUSY`, which is how the runner reports work still draining. */
async function refuseWithRunnerBusy(device: DeviceInfo, session: RunnerSession): Promise<void> {
  mockSendRunnerCommandOnce.mockResolvedValueOnce(
    runnerError({
      code: 'RUNNER_BUSY',
      message: 'The iOS runner is still finishing a previous command that exceeded its watchdog',
    }),
  );
  await assert.rejects(() =>
    executeRunnerCommandWithSession(
      device,
      session,
      { command: 'tap', x: 120, y: 240, appBundleId: 'com.example.demo' },
      '/tmp/runner.log',
      30_000,
    ),
  );
  assert.equal(session.runnerMainThreadBusy, true);
}

/** A served reply stamped idle: the runner reached the main thread, so its work drained. */
async function drainRunnerMainThread(device: DeviceInfo, session: RunnerSession): Promise<void> {
  mockSendRunnerCommandOnce.mockResolvedValueOnce(
    runnerResponse({ tapped: true, runnerMainThreadBusy: false }),
  );
  await executeRunnerCommandWithSession(
    device,
    session,
    { command: 'tap', x: 130, y: 250, appBundleId: 'com.example.demo' },
    '/tmp/runner.log',
    30_000,
  );
}

function deviceNamed(name: string): DeviceInfo {
  return { ...IOS_SIMULATOR, id: `${name}-sim` };
}

function runnerLeaseExists(deviceId: string): boolean {
  return fs.existsSync(
    path.join(process.env.AGENT_DEVICE_IOS_RUNNER_LEASE_DIR ?? '', `${deviceId}.json`),
  );
}
