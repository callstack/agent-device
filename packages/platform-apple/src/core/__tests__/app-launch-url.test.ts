import { beforeEach, test, vi } from 'vitest';
import assert from 'node:assert/strict';
import { AppError } from '@agent-device/kernel/errors';
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

import { runCmd } from '@agent-device/host-kit/command';
import { ensureBootedSimulator } from '../simulator.ts';
import { openIosApp } from '../app-launch.ts';

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
      {
        timeoutMs: IOS_SIMULATOR_OPENURL_TIMEOUT_MS,
      },
    ],
  ]);
});

test('iOS simulator URL open times out a hanging provider with unknown dispatch', async () => {
  vi.useFakeTimers();
  try {
    mockRunCmd.mockImplementation(
      async (_cmd, _args, options) =>
        await new Promise((_resolve, reject) => {
          const timeoutMs = options?.timeoutMs ?? 0;
          setTimeout(() => {
            reject(
              new AppError('COMMAND_FAILED', 'xcrun timed out', {
                timeoutMs,
              }),
            );
          }, timeoutMs);
        }),
    );

    const pending = openIosApp(IOS_TEST_SIMULATOR, 'MyApp', {
      appBundleId: 'com.example.app',
      url: 'myapp://automation',
    }).catch((error: unknown) => error);

    await Promise.resolve();
    assert.equal(mockRunCmd.mock.calls[0]?.[2]?.timeoutMs, IOS_SIMULATOR_OPENURL_TIMEOUT_MS);
    await vi.advanceTimersByTimeAsync(IOS_SIMULATOR_OPENURL_TIMEOUT_MS);
    const failure = await pending;

    assert.ok(failure instanceof AppError);
    assert.equal(failure.code, 'COMMAND_FAILED');
    assert.equal(failure.details?.reason, 'ios-simulator-openurl-timeout');
    assert.equal(failure.details?.dispatched, 'unknown');
    assert.equal(failure.details?.timeoutMs, IOS_SIMULATOR_OPENURL_TIMEOUT_MS);
  } finally {
    vi.useRealTimers();
  }
});

test('iOS simulator URL open forwards the request signal to simctl openurl', async () => {
  const controller = new AbortController();

  await openIosApp(IOS_TEST_SIMULATOR, 'MyApp', {
    appBundleId: 'com.example.app',
    runnerOptions: { signal: controller.signal },
    url: 'myapp://automation',
  });

  assert.equal(mockRunCmd.mock.calls.length, 1);
  assert.equal(mockRunCmd.mock.calls[0]?.[2]?.signal, controller.signal);
});
