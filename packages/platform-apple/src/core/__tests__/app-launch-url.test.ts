import { beforeEach, test, vi } from 'vitest';
import assert from 'node:assert/strict';
import { IOS_TEST_SIMULATOR } from './apple-core-stub-helpers.ts';
import { IOS_SIMULATOR_OPENURL_TIMEOUT_MS, IOS_SIMULATOR_TERMINATE_TIMEOUT_MS } from '../config.ts';

vi.mock('@agent-device/host-kit/command', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent-device/host-kit/command')>();
  return { ...actual, runCmd: vi.fn(actual.runCmd) };
});
vi.mock('../simulator.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../simulator.ts')>();
  return { ...actual, ensureBootedSimulator: vi.fn(actual.ensureBootedSimulator) };
});

import { AppError } from '@agent-device/kernel/errors';
import { runCmd } from '@agent-device/host-kit/command';
import { ensureBootedSimulator } from '../simulator.ts';
import { IOS_SIMULATOR_OPENURL_TIMEOUT_REASON, openIosApp } from '../app-launch.ts';

const mockRunCmd = vi.mocked(runCmd);
const mockEnsureBootedSimulator = vi.mocked(ensureBootedSimulator);

beforeEach(() => {
  vi.resetAllMocks();
  mockEnsureBootedSimulator.mockResolvedValue();
  mockRunCmd.mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });
});

test('iOS simulator URL relaunch terminates the app before opening the URL', async () => {
  await openIosApp(IOS_TEST_SIMULATOR, 'MyApp', {
    appBundleId: 'com.example.app',
    url: 'myapp://automation',
    terminateRunningApp: true,
  });

  assert.deepEqual(mockRunCmd.mock.calls, [
    [
      'xcrun',
      ['simctl', 'terminate', 'sim-1', 'com.example.app'],
      {
        allowFailure: true,
        timeoutMs: IOS_SIMULATOR_TERMINATE_TIMEOUT_MS,
      },
    ],
    [
      'xcrun',
      ['simctl', 'openurl', 'sim-1', 'myapp://automation'],
      { timeoutMs: IOS_SIMULATOR_OPENURL_TIMEOUT_MS },
    ],
  ]);
});

test('a Simulator that never answers openurl fails the open at its own bound', async () => {
  mockRunCmd.mockRejectedValueOnce(
    new AppError('COMMAND_FAILED', 'xcrun timed out after 20000ms', { timeoutMs: 20_000 }),
  );

  const failure = await openIosApp(IOS_TEST_SIMULATOR, 'myapp://automation', {})
    .then(() => undefined)
    .catch((error: unknown) => error);

  assert.ok(failure instanceof AppError);
  assert.equal(failure.code, 'COMMAND_FAILED');
  assert.deepEqual(failure.details, {
    reason: IOS_SIMULATOR_OPENURL_TIMEOUT_REASON,
    timeoutMs: IOS_SIMULATOR_OPENURL_TIMEOUT_MS,
    deviceId: IOS_TEST_SIMULATOR.id,
    hint: failure.details?.hint,
  });
});

test('a request canceled while openurl runs stays a canceled request', async () => {
  const canceled = new AppError('COMMAND_FAILED', 'request canceled');
  mockRunCmd.mockRejectedValueOnce(canceled);

  const failure = await openIosApp(IOS_TEST_SIMULATOR, 'myapp://automation', {})
    .then(() => undefined)
    .catch((error: unknown) => error);

  assert.equal(failure, canceled);
});
