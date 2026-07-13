import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, test, vi } from 'vitest';
import { IOS_DEVICE, IOS_SIMULATOR } from '../../../../__tests__/test-utils/index.ts';

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

vi.mock('../../../../utils/host-process.ts', async () => {
  const actual = await vi.importActual<typeof import('../../../../utils/host-process.ts')>(
    '../../../../utils/host-process.ts',
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
    getFreePort: mockGetFreePort,
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
  clearRequestCanceled,
  createRequestCanceledError,
  getRequestSignal,
  isRequestCanceledError,
  markRequestCanceled,
  registerRequestAbort,
} from '../../../../request/cancel.ts';
import { abortAllIosRunnerSessions, getRunnerSessionSnapshot } from '../runner/runner-session.ts';
import { setRunnerLeaseOwnerStateDir, type RunnerLease } from '../runner/runner-lease.ts';
import { executeRunnerCommand, prepareLocalIosRunner } from '../runner/runner-lifecycle.ts';

beforeEach(async () => {
  await abortAllIosRunnerSessions();
  vi.resetAllMocks();
  setRunnerLeaseOwnerStateDir(undefined);
  process.env.AGENT_DEVICE_IOS_RUNNER_LEASE_DIR = fs.mkdtempSync(
    path.join(os.tmpdir(), 'agent-device-runner-cancellation-test-'),
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
