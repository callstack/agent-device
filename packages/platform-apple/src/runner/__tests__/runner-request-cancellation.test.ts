import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, test, vi } from 'vitest';
import { IOS_DEVICE, IOS_SIMULATOR } from './device-fixtures.ts';
import { mkdtempForTestSync } from './tmp-dir.ts';
import { appleRunnerTestHost } from '../test-host.ts';

const {
  mockAcquireXcodebuildSimulatorSetRedirect,
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
  mockSignalPidsBestEffort,
  mockSignalProcessGroupBestEffort,
  mockWaitForRunner,
  mockRedirectRelease,
} = vi.hoisted(() => ({
  mockAcquireXcodebuildSimulatorSetRedirect: vi.fn(),
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
  // Runner child pids here are fabricated (4141..4444); see runner-session.test.ts.
  mockSignalPidsBestEffort: vi.fn(),
  mockSignalProcessGroupBestEffort: vi.fn(),
  mockWaitForRunner: vi.fn(),
  mockRedirectRelease: vi.fn(),
}));

vi.mock('../runner-io.ts', async () => {
  const actual = await vi.importActual<typeof import('../runner-io.ts')>('../runner-io.ts');
  return {
    ...actual,
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

import { createRequestCanceledError, isRequestCanceledError } from '@agent-device/kernel/errors';
import { abortAllIosRunnerSessions, getRunnerSessionSnapshot } from '../runner-session.ts';
import type { RunnerLease } from '../runner-lease.ts';
import { executeRunnerCommand, prepareLocalIosRunner } from '../runner-lifecycle.ts';

// Root-registry writers (`request/cancel.ts`) are not visible to the package;
// this reproduces the same canceled-set/AbortController-map model locally and
// backs the host's read-only `isRequestCanceled`/`getRequestSignal` with it,
// so call sites below keep the original registerRequestAbort/markRequestCanceled/
// clearRequestCanceled/getRequestSignal names and semantics.
const canceledRequestIds = new Set<string>();
const requestAbortControllers = new Map<string, AbortController>();

function registerRequestAbort(requestId: string | undefined): void {
  if (!requestId) return;
  const controller = new AbortController();
  requestAbortControllers.set(requestId, controller);
  if (canceledRequestIds.has(requestId)) {
    controller.abort(createRequestCanceledError());
  }
}

function markRequestCanceled(requestId: string | undefined): void {
  if (!requestId) return;
  canceledRequestIds.add(requestId);
  requestAbortControllers.get(requestId)?.abort(createRequestCanceledError());
}

function clearRequestCanceled(requestId: string | undefined): void {
  if (!requestId) return;
  canceledRequestIds.delete(requestId);
  requestAbortControllers.delete(requestId);
}

function getRequestSignal(requestId: string | undefined): AbortSignal | undefined {
  if (!requestId) return undefined;
  return requestAbortControllers.get(requestId)?.signal;
}

beforeEach(async () => {
  // Installed before the leading `abortAllIosRunnerSessions()` cleanup below:
  // that cleanup can dispose a session a PRIOR test deliberately left running
  // (e.g. the survivor in the previous test), so the host overrides must
  // already be in place before that disposal fires, not after.
  canceledRequestIds.clear();
  requestAbortControllers.clear();
  appleRunnerTestHost.update({
    isRequestCanceled: (requestId) => requestId !== undefined && canceledRequestIds.has(requestId),
    getRequestSignal,
    // `setRunnerLeaseOwnerStateDir` is a root-only mutator (runner-owner-state.ts)
    // the package cannot see; overriding the host's read side reproduces the
    // same "no configured owner state dir" state directly.
    leaseOwnerStateDir: () => undefined,
    runCmdBackground: mockRunCmdBackground,
    isProcessAlive: mockIsProcessAlive,
    isProcessGroupAlive: mockIsProcessGroupAlive,
    signalPidsBestEffort: mockSignalPidsBestEffort,
    signalProcessGroupBestEffort: mockSignalProcessGroupBestEffort,
    runAppleToolCommand: mockRunAppleToolCommand,
    runXcrun: mockRunXcrun,
  });
  await abortAllIosRunnerSessions();
  vi.resetAllMocks();
  process.env.AGENT_DEVICE_IOS_RUNNER_LEASE_DIR = mkdtempForTestSync(
    'agent-device-runner-cancellation-test-',
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
  mockAcquireXcodebuildSimulatorSetRedirect.mockResolvedValue({
    release: mockRedirectRelease,
  });
  mockRunCmdBackground.mockReturnValue(makeBackgroundRunner(4242));
  mockRunAppleToolCommand.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });
  mockIsProcessAlive.mockReturnValue(true);
  mockIsProcessGroupAlive.mockReturnValue(false);
  mockWaitForRunner.mockResolvedValue(runnerResponse({ uptimeMs: 1 }));
});

test('direct command cancellation reaches runner launch without a registered request', async () => {
  const controller = new AbortController();
  const device = { ...IOS_SIMULATOR, id: 'runner-direct-signal-sim' };
  mockRunCmdBackground.mockImplementationOnce((_cmd, _args, options) => {
    assert.equal(options?.signal, controller.signal);
    controller.abort(new Error('wait deadline exceeded'));
    return makeBackgroundRunner(4141);
  });

  await assert.rejects(
    executeRunnerCommand(
      device,
      { command: 'snapshot', appBundleId: 'com.example.demo' },
      { signal: controller.signal, logPath: '/tmp/runner.log' },
    ),
    (error: unknown) => isRequestCanceledError(error),
  );

  assert.equal(getRunnerSessionSnapshot(device.id), null);
});

test('prepare cancellation stops only its runner and preserves unrelated prep', async () => {
  const survivorRequestId = 'prepare-runner-survivor-B';
  const canceledRequestId = 'prepare-runner-canceled-A';
  const survivorDevice = { ...IOS_SIMULATOR, id: 'prepare-survivor-sim' };
  const canceledDevice = { ...IOS_DEVICE, id: 'prepare-canceled-device' };
  registerRequestAbort(survivorRequestId);
  registerRequestAbort(canceledRequestId);

  try {
    await prepareLocalIosRunner(survivorDevice, {
      requestId: survivorRequestId,
      logPath: '/tmp/runner.log',
      healthTimeoutMs: 30_000,
    });
    assert.ok(getRunnerSessionSnapshot(survivorDevice.id)?.alive);

    mockWaitForRunner.mockImplementation(async () => {
      markRequestCanceled(canceledRequestId);
      throw createRequestCanceledError();
    });
    await assert.rejects(
      prepareLocalIosRunner(canceledDevice, {
        requestId: canceledRequestId,
        logPath: '/tmp/runner.log',
        healthTimeoutMs: 30_000,
      }),
      (error: unknown) => isRequestCanceledError(error),
    );

    const canceledSignal = getRequestSignal(canceledRequestId);
    assert.ok(mockRunCmdBackground.mock.calls.some((call) => call[2]?.signal === canceledSignal));
    assert.equal(canceledSignal?.aborted, true);
    assert.equal(getRunnerSessionSnapshot(canceledDevice.id), null);
    assert.ok(getRunnerSessionSnapshot(survivorDevice.id)?.alive);
  } finally {
    clearRequestCanceled(survivorRequestId);
    clearRequestCanceled(canceledRequestId);
  }
});

test('normal command cancellation during launch or initial readiness retains no session or lease', async () => {
  const survivorRequestId = 'runner-command-survivor';
  const launchCanceledRequestId = 'runner-command-launch-canceled';
  const readinessCanceledRequestId = 'runner-command-readiness-canceled';
  const survivorDevice = { ...IOS_SIMULATOR, id: 'runner-command-survivor-sim' };
  const launchCanceledDevice = { ...IOS_DEVICE, id: 'runner-command-launch-canceled-device' };
  const readinessCanceledDevice = {
    ...IOS_DEVICE,
    id: 'runner-command-readiness-canceled-device',
  };
  registerRequestAbort(survivorRequestId);
  registerRequestAbort(launchCanceledRequestId);
  registerRequestAbort(readinessCanceledRequestId);

  try {
    await executeRunnerCommand(
      survivorDevice,
      { command: 'snapshot', appBundleId: 'com.example.demo' },
      { requestId: survivorRequestId, logPath: '/tmp/runner.log' },
    );
    assert.ok(getRunnerSessionSnapshot(survivorDevice.id)?.alive);

    const canceledSignal = getRequestSignal(launchCanceledRequestId);
    mockRunCmdBackground.mockImplementationOnce((_cmd, _args, options) => {
      assert.equal(options?.signal, canceledSignal);
      markRequestCanceled(launchCanceledRequestId);
      return makeBackgroundRunner(4343);
    });

    await assert.rejects(
      executeRunnerCommand(
        launchCanceledDevice,
        { command: 'snapshot', appBundleId: 'com.example.demo' },
        { requestId: launchCanceledRequestId, logPath: '/tmp/runner.log' },
      ),
      (error: unknown) => isRequestCanceledError(error),
    );

    mockRunCmdBackground.mockReturnValue(makeBackgroundRunner(4444));
    mockWaitForRunner.mockImplementationOnce(async () => {
      markRequestCanceled(readinessCanceledRequestId);
      throw createRequestCanceledError();
    });
    await assert.rejects(
      executeRunnerCommand(
        readinessCanceledDevice,
        { command: 'snapshot', appBundleId: 'com.example.demo' },
        { requestId: readinessCanceledRequestId, logPath: '/tmp/runner.log' },
      ),
      (error: unknown) => isRequestCanceledError(error),
    );

    assert.equal(getRunnerSessionSnapshot(launchCanceledDevice.id), null);
    assert.equal(getRunnerSessionSnapshot(readinessCanceledDevice.id), null);
    assert.ok(getRunnerSessionSnapshot(survivorDevice.id)?.alive);
    assert.deepEqual(readRetainedLeaseDeviceIds(), [survivorDevice.id]);
  } finally {
    clearRequestCanceled(survivorRequestId);
    clearRequestCanceled(launchCanceledRequestId);
    clearRequestCanceled(readinessCanceledRequestId);
  }
});

function readRetainedLeaseDeviceIds(): string[] {
  return fs.readdirSync(process.env.AGENT_DEVICE_IOS_RUNNER_LEASE_DIR!).map((entry) => {
    const contents = fs.readFileSync(
      path.join(process.env.AGENT_DEVICE_IOS_RUNNER_LEASE_DIR!, entry),
      'utf8',
    );
    return (JSON.parse(contents) as RunnerLease).deviceId;
  });
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
