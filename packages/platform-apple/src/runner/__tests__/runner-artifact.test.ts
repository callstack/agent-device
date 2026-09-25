import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, test, vi } from 'vitest';
import { AppError, isRequestCanceledError } from '@agent-device/kernel/errors';
import { resetAllProcessMemosForTests } from '@agent-device/kernel/ttl-memo';
import type { ExecResult } from '@agent-device/host-kit/command';
import { createLocalAppleToolProvider, withAppleToolProvider } from '../../core/tool-provider.ts';
import { appleRunnerTestHost } from '../test-host.ts';
import { COLD_TOOLCHAIN_PROBE_TIMEOUT_MS } from '../apple-runner-platform.ts';
import { createRunnerPhaseBudget, ensureXctestrunArtifact } from '../runner-xctestrun.ts';
import { resolveXcodebuildSimulatorDeviceSetPath } from '../runner-device-set.ts';
import { appleToolchainProbeResult } from './apple-toolchain-fixtures.ts';
import { IOS_SIMULATOR } from './device-fixtures.ts';
import { mkdtempForTestSync } from './tmp-dir.ts';
import {
  withFakeXcrunHost,
  writeFakeXcrunShims,
} from '../../core/__tests__/xcrun-shim-fixtures.ts';

const runCmdSync = vi.fn();
const runCmdStreaming = vi.fn();
const originalHome = process.env.HOME;
let root: string;

beforeEach(() => {
  resetAllProcessMemosForTests();
  root = mkdtempForTestSync('agent-device-runner-artifact-');
  const projectRoot = path.join(root, 'project');
  fs.mkdirSync(
    path.join(projectRoot, 'apple', 'runner', 'AgentDeviceRunner', 'AgentDeviceRunner.xcodeproj'),
    { recursive: true },
  );
  process.env.AGENT_DEVICE_IOS_RUNNER_DERIVED_PATH = path.join(root, 'derived');
  // The build path redirects the host's own `~/Library/Developer/XCTestDevices`.
  process.env.HOME = path.join(root, 'home');
  runCmdSync.mockReset().mockImplementation(appleToolchainProbeResult);
  runCmdStreaming
    .mockReset()
    .mockImplementation(async (): Promise<ExecResult> => ({ exitCode: 0, stdout: '', stderr: '' }));
  appleRunnerTestHost.update({
    runCmdSync,
    runCmdStreaming,
    findProjectRoot: () => projectRoot,
    readVersion: () => '0.0.0-test',
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.AGENT_DEVICE_IOS_RUNNER_DERIVED_PATH;
  process.env.HOME = originalHome;
});

test('a scoped-set simulator on a cache miss is refused before build-for-testing', async () => {
  const requestedSetPath = path.join(root, 'user-set');
  fs.mkdirSync(requestedSetPath, { recursive: true });
  const xctestDeviceSetPath = resolveXcodebuildSimulatorDeviceSetPath();
  assert.equal(xctestDeviceSetPath.startsWith(root), true);
  fs.mkdirSync(xctestDeviceSetPath, { recursive: true });
  const host = writeFakeXcrunShims(root, {
    simctl: { expectedVersion: '1051.17.7', installedVersion: '1155.4' },
    devicectl: { expectedVersion: '506.6', installedVersion: '629.3' },
  });

  await assert.rejects(
    withFakeXcrunHost(host, () =>
      ensureXctestrunArtifact(
        { ...IOS_SIMULATOR, simulatorSetPath: requestedSetPath },
        { budget: createRunnerPhaseBudget(120_000, undefined) },
      ),
    ),
    (error: unknown) =>
      error instanceof AppError && error.details?.reason === 'xctest_device_set_cleanup_armed',
  );

  assert.equal(runCmdStreaming.mock.calls.length, 0, 'no xcodebuild build-for-testing ran');
  assert.equal(fs.lstatSync(xctestDeviceSetPath).isSymbolicLink(), false);
});

test('a build phase with less left than the cold budget caps the shim probe at what it has left', async () => {
  const requestedSetPath = path.join(root, 'user-set');
  fs.mkdirSync(requestedSetPath, { recursive: true });
  fs.mkdirSync(resolveXcodebuildSimulatorDeviceSetPath(), { recursive: true });
  const host = writeFakeXcrunShims(root, {
    simctl: { expectedVersion: '1051.17.7', installedVersion: '1155.4' },
    devicectl: { hook: 'none' },
  });
  const phaseMs = 5_000;
  const timeout = vi.spyOn(AbortSignal, 'timeout');

  await assert.rejects(
    withFakeXcrunHost(host, () =>
      ensureXctestrunArtifact(
        { ...IOS_SIMULATOR, simulatorSetPath: requestedSetPath },
        { budget: createRunnerPhaseBudget(phaseMs, undefined) },
      ),
    ),
    (error: unknown) =>
      error instanceof AppError && error.details?.reason === 'xctest_device_set_cleanup_armed',
  );

  assert.equal(phaseMs < COLD_TOOLCHAIN_PROBE_TIMEOUT_MS, true);
  assert.equal(timeout.mock.calls.length, 1);
  const probeBudgetMs = timeout.mock.calls[0]?.[0] ?? Number.NaN;
  assert.equal(probeBudgetMs > 0 && probeBudgetMs <= phaseMs, true, `${probeBudgetMs} ms`);
});

test('a build canceled while the shims are probed releases the device set without building', async () => {
  const requestedSetPath = path.join(root, 'user-set');
  fs.mkdirSync(requestedSetPath, { recursive: true });
  fs.mkdirSync(resolveXcodebuildSimulatorDeviceSetPath(), { recursive: true });
  const request = new AbortController();
  let finds = 0;
  const xcrun = createLocalAppleToolProvider({
    runCommand: async (_cmd, _args, options): Promise<ExecResult> => {
      finds += 1;
      request.abort();
      const stopped: ExecResult = { exitCode: 1, stdout: '', stderr: '' };
      const signal = options?.signal;
      if (!signal || signal.aborted) return stopped;
      return await new Promise<ExecResult>((resolve) => {
        signal.addEventListener('abort', () => resolve(stopped), { once: true });
      });
    },
  });

  await assert.rejects(
    withAppleToolProvider(xcrun, () =>
      ensureXctestrunArtifact(
        { ...IOS_SIMULATOR, simulatorSetPath: requestedSetPath },
        { budget: createRunnerPhaseBudget(120_000, request.signal) },
      ),
    ),
    (error: unknown) => isRequestCanceledError(error),
  );

  assert.notEqual(finds, 0, 'the probe had started');
  assert.equal(runCmdStreaming.mock.calls.length, 0, 'no xcodebuild build-for-testing ran');
  assert.equal(
    fs.existsSync(path.join(root, 'home', '.agent-device', 'xctest-device-set.lock')),
    false,
  );
});
