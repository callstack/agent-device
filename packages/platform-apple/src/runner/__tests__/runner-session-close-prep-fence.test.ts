import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, test, vi } from 'vitest';
import { createRequestCanceledError, isRequestCanceledError } from '@agent-device/kernel/errors';
import type { ExecBackgroundResult, ExecResult } from '@agent-device/host-kit/command';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { appleRunnerTestHost } from '../test-host.ts';
import {
  makeClassifyOwnerLivenessViaMocks,
  makeBackgroundRunner,
  runnerResponse,
} from './runner-session-fixtures.ts';
import { appleToolchainProbeResult } from './apple-toolchain-fixtures.ts';
import { seedRunnerProductBundle } from './runner-xctestrun.fixtures.ts';
import { mkdtempForTestSync } from './tmp-dir.ts';

/**
 * The live incident of #3220, as a control: a start holds the runner session lock through a cold
 * `build-for-testing`, a non-retained `close` begins and kills that build, and the same caller
 * retries the start while close still waits for the lock. No second prep child is spawned, and
 * close settles instead of waiting on a replacement build.
 *
 * Everything below the exec seam is production code: the session lock, the admission fence, the
 * prep ledger, the artifact cache decision, and the spawn decision itself. Only `xcodebuild`,
 * the Apple tools, and the process table are stood in for.
 */

const XCTESTRUN_NAME =
  'AgentDeviceRunner_AgentDeviceRunnerUITests_iphonesimulator27.0-arm64.xctestrun';

const {
  mockBuildForTesting,
  mockCleanupTempFile,
  mockGetFreePort,
  mockIsProcessAlive,
  mockIsProcessGroupAlive,
  mockPrepareXctestrunWithEnv,
  mockReadProcessCommand,
  mockReadProcessStartTime,
  mockRunAppleToolCommand,
  mockRunCmdBackground,
  mockRunXcrun,
  mockSignalPidsBestEffort,
  mockSignalProcessGroupBestEffort,
  mockWaitForRunner,
} = vi.hoisted(() => ({
  mockBuildForTesting: vi.fn(),
  mockCleanupTempFile: vi.fn(),
  mockGetFreePort: vi.fn(),
  mockIsProcessAlive: vi.fn(),
  mockIsProcessGroupAlive: vi.fn(),
  mockPrepareXctestrunWithEnv: vi.fn(),
  mockReadProcessCommand: vi.fn((_pid: number) => null as string | null),
  mockReadProcessStartTime: vi.fn((_pid: number) => 'fixed-test-owner-start-time' as string | null),
  mockRunAppleToolCommand: vi.fn(),
  mockRunCmdBackground: vi.fn(),
  mockRunXcrun: vi.fn(),
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

vi.mock('../runner-startup-transport.ts', async () => {
  const actual = await vi.importActual<typeof import('../runner-startup-transport.ts')>(
    '../runner-startup-transport.ts',
  );
  return { ...actual, waitForRunner: mockWaitForRunner };
});

// The session-xctestrun env step shells out to `plutil`; it is not the subject here, and the
// fixture build's plist is not something the host's tools have to agree to read.
vi.mock('../runner-artifact-env.ts', async () => {
  const actual = await vi.importActual<typeof import('../runner-artifact-env.ts')>(
    '../runner-artifact-env.ts',
  );
  return {
    ...actual,
    prepareXctestrunWithEnv: mockPrepareXctestrunWithEnv,
  };
});

import {
  abortAllIosRunnerSessions,
  ensureRunnerSession,
  releaseIosRunnerOnClose,
} from '../runner-session.ts';
import { runnerPrepProcessChildren, runnerStartTeardownPending } from '../runner-xctestrun.ts';

let projectRoot: string;
let derived: string;
/** The `build-for-testing` children this test's seam created, in spawn order. */
let builds: { pid: number; kill: () => void }[];

const IOS_ADMISSION_SIMULATOR: DeviceInfo = {
  platform: 'apple',
  appleOs: 'ios',
  id: 'runner-close-fence-sim',
  name: 'iPhone 17 Pro',
  kind: 'simulator',
  booted: true,
};

// The overrides below are this file's scratch dirs; a later test in this worker
// must not inherit them. Nothing between module load and the first beforeEach
// changes these, so capturing them here is the same state beforeEach restores.
const previousDerived = process.env.AGENT_DEVICE_IOS_RUNNER_DERIVED_PATH;
const previousLeaseDir = process.env.AGENT_DEVICE_IOS_RUNNER_LEASE_DIR;
afterEach(() => {
  if (previousDerived === undefined) delete process.env.AGENT_DEVICE_IOS_RUNNER_DERIVED_PATH;
  else process.env.AGENT_DEVICE_IOS_RUNNER_DERIVED_PATH = previousDerived;
  if (previousLeaseDir === undefined) delete process.env.AGENT_DEVICE_IOS_RUNNER_LEASE_DIR;
  else process.env.AGENT_DEVICE_IOS_RUNNER_LEASE_DIR = previousLeaseDir;
});

beforeEach(async () => {
  projectRoot = mkdtempForTestSync('agent-device-close-fence-root-');
  fs.mkdirSync(
    path.join(projectRoot, 'apple', 'runner', 'AgentDeviceRunner', 'AgentDeviceRunner.xcodeproj'),
    { recursive: true },
  );
  derived = mkdtempForTestSync('agent-device-close-fence-derived-');
  process.env.AGENT_DEVICE_IOS_RUNNER_DERIVED_PATH = derived;
  process.env.AGENT_DEVICE_IOS_RUNNER_LEASE_DIR = mkdtempForTestSync('agent-device-close-fence-');
  builds = [];
  appleRunnerTestHost.update({
    runCmdStreaming: mockBuildForTesting,
    runCmdSync: vi.fn().mockImplementation(appleToolchainProbeResult),
    runCmdBackground: mockRunCmdBackground,
    findProjectRoot: () => projectRoot,
    readVersion: () => '0.0.0-test',
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
  appleRunnerTestHost.update({
    runCmdStreaming: mockBuildForTesting,
    runCmdSync: vi.fn().mockImplementation(appleToolchainProbeResult),
    findProjectRoot: () => projectRoot,
    readVersion: () => '0.0.0-test',
  });
  mockRunXcrun.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });
  mockRunAppleToolCommand.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });
  mockRunCmdBackground.mockReturnValue(makeBackgroundRunner(4242));
  mockGetFreePort.mockResolvedValue(8123);
  mockPrepareXctestrunWithEnv.mockResolvedValue({
    xctestrunPath: '/tmp/session-runner.xctestrun',
    jsonPath: '/tmp/session-runner.json',
  });
  mockIsProcessAlive.mockReturnValue(true);
  mockIsProcessGroupAlive.mockReturnValue(false);
  mockReadProcessCommand.mockReturnValue(null);
  mockReadProcessStartTime.mockImplementation((pid: number) =>
    pid === process.pid ? 'fixed-test-owner-start-time' : null,
  );
  mockWaitForRunner.mockResolvedValue(runnerResponse({ uptimeMs: 1 }));
  mockBuildForTesting.mockImplementation((_command: string, _args: string[], options: any) =>
    hangBuildForTesting(options),
  );
});

test('close during a cold build leaves the start no way to spawn a replacement build', async () => {
  const device = IOS_ADMISSION_SIMULATOR;
  // Park close inside its prep stop: the kill is attempted, but the stop has not returned, so
  // close provably has not reached the session lock yet (the start holds it) and no later fence
  // could have run. That is the moment the device must already be fenced.
  let releasePrepStop: () => void = () => {};
  const prepStopParked = new Promise<void>((resolve) => {
    releasePrepStop = resolve;
  });
  let signalAttempted = () => {};
  const killAttempted = new Promise<void>((resolve) => {
    signalAttempted = resolve;
  });
  mockRunAppleToolCommand.mockImplementation(async (tool: string, args: string[]) => {
    // `killRunnerProcessTree` is the only pkill that signals by parent pid (`-P`); the lease
    // cleanup's stale-launch sweep matches argv (`-f`), so only the prep tree-kill parks.
    if (tool === 'pkill' && args.includes('-P')) {
      signalAttempted();
      await prepStopParked;
    }
    return { exitCode: 0, stdout: '', stderr: '' };
  });

  // A cold start: holds the session lock for the whole build, as a real one does.
  const firstStart = ensureRunnerSession(device, {}).catch((error: unknown) => error);
  await vi.waitFor(() => assert.equal(builds.length, 1));
  assert.equal(runnerPrepProcessChildren(device.id).length, 1, 'the build is on the prep ledger');

  const closing = releaseIosRunnerOnClose(device.id, { retain: false });
  await killAttempted;
  assert.equal(
    runnerStartTeardownPending(device.id),
    true,
    'the device was fenced before the prep stop finished',
  );

  // The prewarm health retry of the incident: the same caller starts over while close waits.
  const retriedStart = ensureRunnerSession(device, {}).catch((error: unknown) => error);
  releasePrepStop();
  builds[0]!.kill();

  const [first, retried] = await Promise.all([firstStart, retriedStart, closing]);

  assert.ok(first instanceof Error, 'the start whose build was killed failed');
  assert.ok(isRequestCanceledError(retried), 'the retry is refused as a canceled start');
  assert.equal(
    (retried as { details?: { runnerStartRetirementReason?: unknown } }).details
      ?.runnerStartRetirementReason,
    'device_teardown',
    'the refusal carries the typed retirement reason, not just a cancellation',
  );
  assert.equal(mockBuildForTesting.mock.calls.length, 1, 'no replacement build was ever spawned');
  assert.equal(runnerPrepProcessChildren(device.id).length, 0, 'the killed build left the ledger');
});

/**
 * The reviewer's counter-case to the fence: a caller that merely QUEUED behind the close — it
 * never owned the killed build and is not that teardown's retry — must not inherit the fence
 * once the close has settled. It wakes, re-routes to a fresh admission, and starts on its own.
 */
test('a start queued behind a close starts fresh once that close has settled', async () => {
  const device = { ...IOS_ADMISSION_SIMULATOR, id: 'runner-close-queued-sim' };
  const firstStart = ensureRunnerSession(device, {}).catch((error: unknown) => error);
  await vi.waitFor(() => assert.equal(builds.length, 1));

  const closing = releaseIosRunnerOnClose(device.id, { retain: false });
  // Close has killed the prep child (proven by the empty ledger) and now waits on the session
  // lock; the fence is in effect. The killed build frees that lock, and this caller is already
  // queued behind close's own stop task, capturing the fenced admission while it still governs.
  await vi.waitFor(() => assert.equal(runnerPrepProcessChildren(device.id).length, 0));
  builds[0]!.kill();
  const queuedStart = ensureRunnerSession(device, {}).catch((error: unknown) => error);
  mockBuildForTesting.mockImplementationOnce(async () => {
    await seedBuiltRunner();
    return { exitCode: 0, stdout: '', stderr: '' } satisfies ExecResult;
  });

  await closing;
  await firstStart;
  const started = await queuedStart;
  assert.ok(!(started instanceof Error), 'the queued caller started fresh: ' + String(started));
  assert.equal(
    mockBuildForTesting.mock.calls.length,
    2,
    'close spawned no replacement; the queued caller built its own runner',
  );
});

/**
 * The nearest negative: with no close in sight, the next start after a killed build is a real
 * start and does build. A fence that simply refused the device after any kill would pass the
 * case above and make every retry impossible.
 */
test('a start after a settled teardown opens fresh and builds', async () => {
  const device = { ...IOS_ADMISSION_SIMULATOR, id: 'runner-close-fence-next-sim' };
  const firstStart = ensureRunnerSession(device, {}).catch((error: unknown) => error);
  await vi.waitFor(() => assert.equal(builds.length, 1));
  const closing = releaseIosRunnerOnClose(device.id, { retain: false });
  await vi.waitFor(() => assert.equal(runnerPrepProcessChildren(device.id).length, 0));
  builds[0]!.kill();
  await closing;
  await firstStart;
  assert.equal(mockBuildForTesting.mock.calls.length, 1);

  mockBuildForTesting.mockImplementationOnce(async () => {
    await seedBuiltRunner();
    return { exitCode: 0, stdout: '', stderr: '' } satisfies ExecResult;
  });
  const next = await ensureRunnerSession(device, {});

  assert.equal(
    mockBuildForTesting.mock.calls.length,
    2,
    'the independent open built its own runner',
  );
  assert.equal(next.deviceId, device.id);
});

/**
 * The reviewer's requestId-only control (#3220 review): R1 holds a cold build and counts as an
 * owner through its registered request signal, with no caller `signal`; R2, also requestId-only,
 * is queued on the session lock behind it. R1's request disconnecting must stop R1's own build
 * and must not refuse R2, which main would have let build its own runner.
 */
test('a queued requestId-only start survives the starting caller disconnecting', async () => {
  const device = { ...IOS_ADMISSION_SIMULATOR, id: 'runner-queued-requestid-sim' };
  const owner = new AbortController();
  appleRunnerTestHost.update({
    getRequestSignal: (id?: string) => (id === 'owner-request' ? owner.signal : undefined),
  });

  const firstStart = ensureRunnerSession(device, { requestId: 'owner-request' }).catch(
    (error: unknown) => error,
  );
  await vi.waitFor(() => assert.equal(builds.length, 1));
  const queued = ensureRunnerSession(device, { requestId: 'queued-request' }).catch(
    (error: unknown) => error,
  );
  mockBuildForTesting.mockImplementationOnce(async () => {
    await seedBuiltRunner();
    return { exitCode: 0, stdout: '', stderr: '' } satisfies ExecResult;
  });

  // The owner's request disconnects: a cancellation, so its own build is stopped...
  owner.abort(createRequestCanceledError());
  builds[0]!.kill();

  const [first, second] = await Promise.all([firstStart, queued]);
  assert.ok(first instanceof Error, 'the disconnected owner start failed');
  assert.ok(!(second instanceof Error), 'the queued start proceeds: ' + String(second));
  assert.equal(
    mockBuildForTesting.mock.calls.length,
    2,
    'one caller disconnecting did not refuse the work of the other',
  );
});

/**
 * A `build-for-testing` that hangs until the test kills it: the exec seam's promise rejects on
 * the kill, the way the tree-kill makes a real one, and its child is registered the way the
 * production spawn seam registers it.
 */
function hangBuildForTesting(options: {
  onSpawn?: (child: ExecBackgroundResult['child']) => void;
}): Promise<ExecResult> {
  const pid = 6100 + builds.length;
  const emitter = new EventEmitter();
  const child = Object.assign(emitter, { pid, exitCode: null }) as ExecBackgroundResult['child'];
  let kill: () => void = () => {};
  const wait = new Promise<ExecResult>((_, reject) => {
    kill = () => {
      emitter.emit('close', 143, null);
      reject(new Error('Command was aborted'));
    };
  });
  builds.push({ pid, kill });
  options.onSpawn?.(child);
  return wait;
}

/** Stands in for a successful `build-for-testing`: the products land under SYMROOT. */
async function seedBuiltRunner(): Promise<void> {
  const symroot = path.join(derived, 'Build', 'Products');
  await seedRunnerProductBundle(
    path.join(symroot, 'Debug-iphonesimulator', 'AgentDeviceRunner.app'),
  );
  fs.writeFileSync(
    path.join(symroot, XCTESTRUN_NAME),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>ProjectRootHint</key>
  <string>${projectRoot}</string>
  <key>ProductPaths</key>
  <array>
    <string>__TESTROOT__/Debug-iphonesimulator/AgentDeviceRunner.app</string>
  </array>
</dict>
</plist>`,
  );
}
